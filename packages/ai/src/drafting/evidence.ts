import { z } from 'zod';

export const evidenceSchema = z.object({
  organizationId: z.uuid(),
  documentId: z.uuid(),
  versionId: z.uuid(),
  chunkId: z.uuid(),
  title: z.string().max(200),
  text: z.string().min(1).max(200000),
  distance: z.number().finite(),
  lexicalRank: z.number().finite(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
const stop = new Set(
  'a an the is are was were be been being to of for from in on at and or with my our your i we you it how what when where why can could would should do does did please help need want about tell me ticket customer synthetic many work happens during'.split(
    ' ',
  ),
);
export function terms(text: string) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !stop.has(word))
    .map((word) =>
      word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word,
    );
  return [...new Set(words)];
}
export function relevance(question: string, text: string) {
  const query = terms(question),
    words = new Set(terms(text));
  return query.length ? query.filter((word) => words.has(word)).length / query.length : 0;
}
export const unsafeInstruction = (text: string) =>
  /ignore\s+(?:all\s+|the\s+|previous\s+)*(?:instructions|rules|system)|system\s*prompt|other\s+(?:tenant|organi[sz]ation)|reveal\s+(?:secrets|credentials)|bypass\s+(?:approval|tenant|security)|<\/?(?:script|system)>/i.test(
    text,
  );
export function rerankEvidence(question: string, rows: readonly Evidence[]): Evidence[] {
  return [...rows].sort(
    (a, b) =>
      relevance(question, b.text) - relevance(question, a.text) ||
      b.lexicalRank - a.lexicalRank ||
      a.distance - b.distance ||
      a.chunkId.localeCompare(b.chunkId),
  );
}
export const generationOutputSchema = z
  .object({
    kind: z.enum(['answer', 'insufficient_evidence']),
    claims: z
      .array(
        z
          .object({
            chunkId: z.uuid(),
            text: z.string().min(12).max(1000),
            quote: z.string().min(12).max(1000),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type GenerationOutput = z.infer<typeof generationOutputSchema>;
export interface ValidatedCitation {
  documentId: string;
  versionId: string;
  chunkId: string;
  title: string;
  quote: string;
  reference: string;
}
export function validateClaims(
  output: GenerationOutput,
  context: readonly Evidence[],
): ValidatedCitation[] | undefined {
  if (output.kind !== 'answer' || !output.claims.length) return undefined;
  const seen = new Set<string>(),
    citations: ValidatedCitation[] = [];
  for (const claim of output.claims) {
    const source = context.find((row) => row.chunkId === claim.chunkId);
    if (
      !source ||
      seen.has(claim.chunkId) ||
      claim.text !== claim.quote ||
      !source.text.includes(claim.quote) ||
      unsafeInstruction(claim.quote)
    )
      return undefined;
    seen.add(claim.chunkId);
    citations.push({
      documentId: source.documentId,
      versionId: source.versionId,
      chunkId: source.chunkId,
      title: source.title,
      quote: claim.quote,
      reference: `[${citations.length + 1}]`,
    });
  }
  return citations;
}
export function renderCitedDraft(citations: readonly ValidatedCitation[]) {
  return citations.map((citation) => `${citation.quote} ${citation.reference}`).join('\n\n');
}
