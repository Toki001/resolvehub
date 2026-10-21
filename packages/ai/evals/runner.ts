import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import type { createDatabase } from '@resolvehub/db';
import { KnowledgeRepository } from '@resolvehub/db';
import {
  DraftingPipeline,
  ExtractiveMockProvider,
  SyntheticEmbeddingProvider,
  syntheticEmbedding,
  draftConfigSchema,
} from '../src/index.js';
import type { RagDraft } from '../src/index.js';
import { corpusSchema, goldenSchema, evalId } from './fixtures.js';
import type { GoldenCase, CorpusRow } from './fixtures.js';

export async function readEvaluationFixtures() {
  const raw = await readFile('packages/ai/evals/golden.jsonl', 'utf8'),
    source = await readFile('packages/ai/evals/corpus.jsonl', 'utf8');
  return {
    cases: raw
      .trim()
      .split('\n')
      .map((line) => goldenSchema.parse(JSON.parse(line))),
    corpus: source
      .trim()
      .split('\n')
      .map((line) => corpusSchema.parse(JSON.parse(line))),
    digest: createHash('sha256').update(raw).update(source).digest('hex'),
  };
}
export async function loadEvaluationCorpus(
  pool: ReturnType<typeof createDatabase>['pool'],
  corpus: readonly CorpusRow[],
) {
  for (const tenant of [0, 1])
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      evalId(`org:${tenant}`),
      `Synthetic RAG evaluation ${tenant}`,
    ]);
  for (const documentId of new Set(corpus.map((row) => row.documentId))) {
    const rows = corpus.filter((r) => r.documentId === documentId),
      first = rows[0];
    if (!first) throw new Error('Empty evaluation document');
    await pool.query(
      "INSERT INTO knowledge_documents(id,organization_id,title,status) VALUES($1,$2,$3,'queued')",
      [documentId, first.organizationId, first.title],
    );
    for (const [index, row] of [...rows]
      .sort((a, b) => Number(a.active) - Number(b.active))
      .entries()) {
      await pool.query(
        "INSERT INTO document_versions(id,organization_id,document_id,object_key,media_type,size_bytes,sha256,revision,status,deleted_at) VALUES($1,$2,$3,$4,'text/plain',$5,$6,$7,$8,$9)",
        [
          row.versionId,
          row.organizationId,
          documentId,
          `organizations/${row.organizationId}/uploads/${row.chunkId}`,
          Buffer.byteLength(row.text),
          createHash('sha256').update(row.text).digest('hex'),
          index + 1,
          row.active ? 'indexed' : 'superseded',
          row.deleted ? '2026-01-01T00:00:00Z' : null,
        ],
      );
      await pool.query(
        'INSERT INTO knowledge_chunks(id,organization_id,document_id,version_id,ordinal,text,content_hash,embedding,embedding_model,embedding_dimensions) VALUES($1,$2,$3,$4,0,$5,$6,$7::public.vector,$8,64)',
        [
          row.chunkId,
          row.organizationId,
          documentId,
          row.versionId,
          row.text,
          createHash('sha256').update(row.text).digest('hex'),
          JSON.stringify(syntheticEmbedding(row.text)),
          'resolvehub-synthetic-sha256-v1',
        ],
      );
      if (row.active)
        await pool.query(
          "UPDATE knowledge_documents SET active_version_id=$3,status='indexed' WHERE organization_id=$1 AND id=$2",
          [row.organizationId, documentId, row.versionId],
        );
    }
  }
}
const ratio = (numerator: number, denominator: number) => {
  if (!denominator) return { numerator, denominator, value: null, wilson95: null };
  const p = numerator / denominator,
    z = 1.96,
    factor = 1 + (z * z) / denominator;
  const center = (p + (z * z) / (2 * denominator)) / factor;
  const radius =
    (z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator * denominator))) /
    factor;
  return {
    numerator,
    denominator,
    value: p,
    wilson95: { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) },
  };
};
export function evaluateResults(
  cases: readonly GoldenCase[],
  corpus: readonly CorpusRow[],
  results: readonly RagDraft[],
) {
  if (cases.length !== results.length || !cases.length)
    throw new Error('Evaluation result count mismatch');
  let recallHits = 0,
    expectedCount = 0,
    supported = 0,
    claims = 0,
    abstained = 0,
    expectedAbstentions = 0,
    leaked = 0,
    answered = 0;
  const failures: string[] = [];
  for (const [index, item] of cases.entries()) {
    const result = results[index];
    if (!result) throw new Error('Missing evaluation result');
    expectedCount += item.expectedEvidence.length;
    recallHits += item.expectedEvidence.filter((expected) =>
      result.trace.retrieved.some(
        (r) =>
          r.chunkId === expected.chunkId &&
          r.documentId === expected.documentId &&
          r.versionId === expected.versionId,
      ),
    ).length;
    if (item.expectedOutcome === 'insufficient_evidence') {
      expectedAbstentions++;
      if (result.generation.outcome === 'insufficient_evidence' && !result.citations.length)
        abstained++;
      else failures.push(`${item.id}:did_not_abstain`);
    } else if (result.generation.outcome === 'answer' && result.citations.length) answered++;
    else failures.push(`${item.id}:unanswered`);
    const allReferences = [...result.trace.retrieved, ...result.trace.context, ...result.citations];
    const foreign = allReferences.some((ref) => {
      const source = corpus.find(
        (row) =>
          row.organizationId === item.organizationId &&
          row.chunkId === ref.chunkId &&
          row.versionId === ref.versionId &&
          row.documentId === ref.documentId &&
          row.active &&
          !row.deleted,
      );
      return (
        !source ||
        ('organizationId' in ref && ref.organizationId !== item.organizationId) ||
        ('text' in ref && ref.text !== source.text)
      );
    });
    if (
      foreign ||
      item.forbiddenStrings.some(
        (text) => result.text.includes(text) || JSON.stringify(result.trace.context).includes(text),
      )
    ) {
      leaked++;
      failures.push(`${item.id}:tenant_or_source_leak`);
    }
    if (
      result.generation.outcome === 'answer' &&
      result.text !==
        result.citations.map((citation) => `${citation.quote} ${citation.reference}`).join('\n\n')
    ) {
      claims++;
      failures.push(`${item.id}:unaccounted_output`);
    }
    claims += result.citations.length;
    for (const citation of result.citations) {
      const source = corpus.find(
        (row) =>
          row.organizationId === item.organizationId &&
          row.chunkId === citation.chunkId &&
          row.documentId === citation.documentId &&
          row.versionId === citation.versionId &&
          row.active &&
          !row.deleted,
      );
      if (
        source?.text.includes(citation.quote) &&
        result.text.includes(`${citation.quote} ${citation.reference}`) &&
        item.expectedEvidence.some((e) => e.chunkId === citation.chunkId)
      )
        supported++;
      else failures.push(`${item.id}:unsupported_claim`);
    }
  }
  return {
    recallAt5: ratio(recallHits, expectedCount),
    supportedClaims: ratio(supported, claims),
    correctAbstention: ratio(abstained, expectedAbstentions),
    tenantLeakage: ratio(leaked, cases.length),
    answered: ratio(answered, cases.filter((c) => c.expectedOutcome === 'answer').length),
    failures,
  };
}
export async function runEvaluation(pool: ReturnType<typeof createDatabase>['pool']) {
  const fixtures = await readEvaluationFixtures();
  const config = draftConfigSchema.parse({});
  const embedding = new SyntheticEmbeddingProvider();
  const pipeline = new DraftingPipeline(
    embedding,
    new ExtractiveMockProvider(),
    {
      search: (org, question, vector, first) =>
        new KnowledgeRepository(pool, org).search(question, vector, first),
    },
    config,
  );
  const results: RagDraft[] = [],
    latencies: number[] = [];
  // Six batches of ten simultaneous real DB-backed requests; no mocked clocks.
  for (let start = 0; start < fixtures.cases.length; start += 10) {
    const batch = fixtures.cases.slice(start, start + 10);
    results.push(
      ...(await Promise.all(
        batch.map(async (item) => {
          const begin = performance.now();
          const result = await pipeline.run(item);
          latencies.push(performance.now() - begin);
          return result;
        }),
      )),
    );
  }
  const metrics = evaluateResults(fixtures.cases, fixtures.corpus, results),
    raw = { hits: 0, expected: 0 };
  for (const item of fixtures.cases.filter((c) => c.category === 'answerable')) {
    const nearest = await new KnowledgeRepository(pool, item.organizationId).nearest(
      syntheticEmbedding(item.question.slice(0, 1000)),
      5,
    );
    raw.expected += item.expectedEvidence.length;
    raw.hits += item.expectedEvidence.filter((e) => nearest.some((r) => r.id === e.chunkId)).length;
  }
  const p95 =
    [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1] ?? Infinity;
  const maxCost = Math.max(...results.map((result) => result.generation.estimatedCostUsd));
  const targets = {
    recall: (metrics.recallAt5.value ?? 0) >= 0.9,
    support: (metrics.supportedClaims.value ?? 0) >= 0.95,
    abstention: (metrics.correctAbstention.value ?? 0) >= 0.95,
    leakage: metrics.tenantLeakage.numerator === 0,
    latency: p95 <= 6000,
    cost: maxCost <= 0.02,
    answers: metrics.answered.numerator === metrics.answered.denominator,
  };
  return {
    fixtureDigest: fixtures.digest,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      postgres: '17/pgvector',
      concurrency: 10,
    },
    provider: 'mock',
    model: config.model,
    embeddingModel: embedding.model,
    retrievalMode: 'hybrid_lexical_rerank',
    pricing: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      effectiveDate: config.priceDate,
      source: 'deterministic mock; no API charges; not a live price estimate',
    },
    cases: fixtures.cases.length,
    corpusVersions: fixtures.corpus.length,
    splits: Object.fromEntries(
      ['answerable', 'insufficient', 'adversarial'].map((category) => {
        const indices = fixtures.cases.flatMap((row, index) =>
          row.category === category ? [index] : [],
        );
        return [
          category,
          evaluateResults(
            indices.map((index) => {
              const row = fixtures.cases[index];
              if (!row) throw new Error('Missing split');
              return row;
            }),
            fixtures.corpus,
            indices.map((index) => {
              const row = results[index];
              if (!row) throw new Error('Missing split result');
              return row;
            }),
          ),
        ];
      }),
    ),
    metrics,
    rawSyntheticVectorRecallAt5: ratio(raw.hits, raw.expected),
    latency: {
      requests: latencies.length,
      p95Ms: p95,
      maxMs: Math.max(...latencies),
      includes:
        'query embedding, PostgreSQL retrieval, context, mock generation, citation validation; excludes BullMQ queue delay',
    },
    cost: {
      maxEstimatedUsd: maxCost,
      totalEstimatedUsd: results.reduce(
        (sum, result) => sum + result.generation.estimatedCostUsd,
        0,
      ),
    },
    targets,
    passed: Object.values(targets).every(Boolean),
    limitations: [
      'Small synthetic set; no production semantic generalization or live-provider SLA/cost claim.',
      'Support measures exact-quotation support, not arbitrary prose entailment. Wilson intervals are descriptive; paired synthetic templates are not independent production samples.',
      'Synthetic hash vectors are not semantic; hybrid lexical retrieval is evaluated and raw vector recall is reported separately.',
      'Normal run uses mock token estimates and zero mock prices.',
    ],
    results: fixtures.cases.map((item, index) => ({
      id: item.id,
      generation: results[index]?.generation,
      citations: results[index]?.citations,
    })),
  };
}
