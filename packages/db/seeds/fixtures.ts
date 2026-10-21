import { createHash } from 'node:crypto';
import { Faker, en } from '@faker-js/faker';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@resolvehub/db';
import type { schema } from '@resolvehub/db';

export const FIXTURE_DATE = '2026-01-15T12:00:00.000Z';
export const FIXTURE_SEED = 3102026;
export function fixtureId(label: string) {
  const hash = createHash('sha256').update(`resolvehub:synthetic:v1:${label}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function syntheticEmbedding(text: string) {
  // Reproducible numeric test vectors, NOT semantic/provider embeddings.
  const values = Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, i) =>
      createHash('sha256').update(`${EMBEDDING_MODEL}:${text}:${i}`).digest().readUInt16BE(0) /
        32767.5 -
      1,
  );
  const norm = Math.hypot(...values);
  return values.map((value) => Number((value / norm).toFixed(8)));
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const topics = [
  {
    subject: 'Refund for a duplicate charge',
    question: 'I see two charges for the same invoice. Can you help me get the duplicate refunded?',
    answer:
      'Please send the invoice number and both transaction references. We verify duplicate charges and refund the duplicate to the original payment method within five business days.',
    policy:
      'Verified duplicate charges are refunded within five business days. Never request full payment card details.',
  },
  {
    subject: 'Unable to reset my password',
    question: 'The password reset email has not arrived. I checked spam and tried twice today.',
    answer:
      'Please check that you used the account email and allow ten minutes for delivery. A reset link expires after thirty minutes. We can verify the account without asking for your password.',
    policy:
      'Password reset links expire after thirty minutes. Agents must never request passwords or authentication codes.',
  },
  {
    subject: 'Exporting workspace reports',
    question: 'How do I export last month’s report for our team? The download button is disabled.',
    answer:
      'Workspace administrators can export completed reports from Reports, then Export CSV. Please confirm your role and the report date range.',
    policy:
      'Only workspace administrators can export reports. Completed reports support CSV export.',
  },
  {
    subject: 'Invite has expired',
    question: 'My teammate opened their invitation this morning but it says the link expired.',
    answer:
      'An administrator can resend the invitation from Settings, then Members. The new invitation expires in seven days and replaces the previous link.',
    policy:
      'Membership invitations expire in seven days. Only an administrator can resend an invite.',
  },
  {
    subject: 'Webhook delivery stopped',
    question:
      'We stopped receiving webhook deliveries after rotating our signing secret yesterday.',
    answer:
      'Please check your endpoint’s delivery status and confirm the current signing secret is configured. Share a delivery ID and timestamp, but never paste the secret.',
    policy:
      'Webhook signatures must be verified against the raw request body. Retry transient delivery failures and never share signing secrets.',
  },
];

type Insert<T extends { $inferInsert: unknown }> = T['$inferInsert'];
export function buildFixtures() {
  const faker = new Faker({ locale: [en] });
  faker.seed(FIXTURE_SEED);
  faker.setDefaultRefDate(FIXTURE_DATE);
  const time = new Date(FIXTURE_DATE);
  const organizations: Insert<typeof schema.organizations>[] = [];
  const memberships: Insert<typeof schema.memberships>[] = [];
  const customers: Insert<typeof schema.customers>[] = [];
  const tickets: Insert<typeof schema.tickets>[] = [];
  const messages: Insert<typeof schema.ticketMessages>[] = [];
  const documents: Insert<typeof schema.knowledgeDocuments>[] = [];
  const versions: Insert<typeof schema.documentVersions>[] = [];
  const chunks: Insert<typeof schema.knowledgeChunks>[] = [];
  const drafts: Insert<typeof schema.draftResponses>[] = [];
  const jobs: Insert<typeof schema.jobRuns>[] = [];
  const audits: Insert<typeof schema.auditEvents>[] = [];
  const receipts: Insert<typeof schema.idempotencyRecords>[] = [];
  for (let org = 0; org < 2; org++) {
    const organizationId = fixtureId(`org:${org}`);
    const membershipId = fixtureId(`member:${org}`);
    const name = org === 0 ? 'Alder Cloud — SYNTHETIC' : 'Cobalt Desk — SYNTHETIC';
    organizations.push({ id: organizationId, name, createdAt: time, updatedAt: time });
    memberships.push({
      id: membershipId,
      organizationId,
      subject: `admin@org-${org}.example.test`,
      role: 'admin',
      createdAt: time,
      updatedAt: time,
    });
    for (let c = 0; c < 40; c++)
      customers.push({
        id: fixtureId(`customer:${org}:${c}`),
        organizationId,
        email: `customer-${c}@org-${org}.example.test`,
        displayName: faker.person.fullName(),
        createdAt: time,
        updatedAt: time,
      });
    for (let d = 0; d < 50; d++) {
      const topic = topics[d % topics.length];
      if (!topic) throw new Error('Missing fixture topic');
      const documentId = fixtureId(`doc:${org}:${d}`);
      const hasFailedRevision = d % 10 === 0;
      const current = hasFailedRevision ? 2 : 3;
      const activeVersionId = fixtureId(`version:${org}:${d}:${current}`);
      documents.push({
        id: documentId,
        organizationId,
        title: `${topic.subject} — ${faker.commerce.department()} policy ${d + 1}`,
        status: 'indexed',
        activeVersionId,
        createdAt: time,
        updatedAt: time,
      });
      for (let revision = 1; revision <= 3; revision++) {
        const versionId = fixtureId(`version:${org}:${d}:${revision}`);
        const text =
          revision === 1
            ? `OUTDATED AND MISLEADING: All refunds are immediate and anyone can export reports. Superseded revision; do not use.`
            : `${name}: ${topic.policy} Policy revision ${revision}. Applies only to this organization.`;
        const status =
          revision === 3 && hasFailedRevision
            ? 'failed'
            : revision === current
              ? 'indexed'
              : 'superseded';
        versions.push({
          id: versionId,
          organizationId,
          documentId,
          revision,
          status,
          objectKey: `organizations/${organizationId}/uploads/${versionId}`,
          mediaType: 'text/plain',
          sizeBytes: Buffer.byteLength(text),
          sha256: hash(text),
          indexedAt: status === 'indexed' ? time : null,
          createdAt: time,
          updatedAt: time,
        });
        for (let ordinal = 0; ordinal < 2; ordinal++) {
          const passage =
            ordinal === 0
              ? text
              : `${text} Contact support with an invoice or delivery reference; never include secrets. Synthetic article ${d + 1}.`;
          chunks.push({
            id: fixtureId(`chunk:${org}:${d}:${revision}:${ordinal}`),
            organizationId,
            documentId,
            versionId,
            ordinal,
            text: passage,
            contentHash: hash(passage),
            embedding: syntheticEmbedding(passage),
            embeddingModel: EMBEDDING_MODEL,
            embeddingDimensions: EMBEDDING_DIMENSIONS,
            createdAt: time,
            updatedAt: time,
          });
        }
      }
      if (hasFailedRevision)
        jobs.push({
          id: fixtureId(`job:${org}:${d}`),
          organizationId,
          kind: 'document_ingestion',
          status: 'failed',
          resourceId: documentId,
          payload: { documentId, versionId: fixtureId(`version:${org}:${d}:3`), synthetic: true },
          attempts: 4,
          reasonCode: 'SYNTHETIC_PROVIDER_UNAVAILABLE',
          availableAt: time,
          dispatchAfter: time,
          requestedBy: membershipId,
          requestId: fixtureId(`request:job:${org}:${d}`),
          createdAt: time,
          updatedAt: time,
        });
    }
    for (let t = 0; t < 100; t++) {
      const topic = topics[t % topics.length];
      if (!topic) throw new Error('Missing fixture topic');
      const ticketId = fixtureId(`ticket:${org}:${t}`);
      const customerId = fixtureId(`customer:${org}:${t % 40}`);
      const createdAt = new Date(time.getTime() + t * 60_000);
      const status = t % 3 === 0 ? 'resolved' : t % 3 === 1 ? 'open' : 'pending';
      tickets.push({
        id: ticketId,
        organizationId,
        customerId,
        customerEmail: `customer-${t % 40}@org-${org}.example.test`,
        subject: topic.subject,
        status,
        createdAt,
        updatedAt: createdAt,
      });
      const conversation = [
        topic.question,
        `Thanks for contacting ${name}. ${topic.answer}`,
        `Thank you. My reference is SYN-${org}-${faker.string.alphanumeric({ length: 8, casing: 'upper' })}. Could you confirm the next step?`,
        status === 'resolved'
          ? 'We verified the reference and completed the requested action. Please reply if you need more help.'
          : 'I have escalated this with the reference provided. We will update this ticket after verification.',
      ];
      if (t % 4 === 0)
        conversation.push(
          'Is there anything else you need from me?',
          'No additional information is required at this stage. We will follow up here.',
        );
      conversation.forEach((body, m) =>
        messages.push({
          id: fixtureId(`message:${org}:${t}:${m}`),
          organizationId,
          ticketId,
          body,
          author: m % 2 === 0 ? 'customer' : 'agent',
          deliveryStatus: m % 2 === 0 ? 'received' : 'internal',
          createdAt: new Date(createdAt.getTime() + m * 120_000),
          updatedAt: new Date(createdAt.getTime() + m * 120_000),
        }),
      );
      if (t < 30) {
        const d = t % 50,
          current = d % 10 === 0 ? 2 : 3;
        const draftId = fixtureId(`draft:${org}:${t}`),
          reviewed = t % 3 !== 0;
        drafts.push({
          id: draftId,
          organizationId,
          ticketId,
          text: topic.answer,
          status: t % 3 === 0 ? 'pending' : t % 3 === 1 ? 'approved' : 'rejected',
          revision: reviewed ? 2 : 1,
          evidenceValidated: true,
          model: 'synthetic-template-v1',
          promptVersion: 'synthetic-support-v1',
          citations: [
            {
              documentId: fixtureId(`doc:${org}:${d}`),
              versionId: fixtureId(`version:${org}:${d}:${current}`),
              chunkId: fixtureId(`chunk:${org}:${d}:${current}:0`),
            },
          ],
          reviewedBy: reviewed ? membershipId : null,
          reviewedAt: reviewed ? time : null,
          reviewReason: t % 3 === 2 ? 'Synthetic review: needs additional account context.' : null,
          createdAt: time,
          updatedAt: time,
        });
        if (reviewed)
          audits.push({
            id: fixtureId(`audit:${org}:${t}`),
            organizationId,
            actorKind: 'membership',
            actorId: membershipId,
            action: t % 3 === 1 ? 'draft.approved' : 'draft.rejected',
            resourceId: draftId,
            requestId: fixtureId(`request:review:${org}:${t}`),
            createdAt: time,
          });
      }
    }
    receipts.push({
      organizationId,
      key: 'synthetic-seed-v1',
      scope: 'fixtures',
      fingerprint: hash(`fixtures:${org}`),
      response: { synthetic: true },
      createdAt: time,
      updatedAt: time,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
  }
  return {
    organizations,
    memberships,
    customers,
    tickets,
    messages,
    documents,
    versions,
    chunks,
    drafts,
    jobs,
    audits,
    receipts,
  };
}
