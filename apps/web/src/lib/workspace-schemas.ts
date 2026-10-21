import { z } from 'zod';

export const identitySchema = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  subject: z.string(),
  role: z.enum(['admin', 'agent', 'analyst']),
});
export const ticketStatusSchema = z.enum(['open', 'pending', 'resolved']);
export const draftStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const jobStatusSchema = z.enum([
  'accepted',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) =>
  z.object({ edges: z.array(z.object({ cursor: z.string(), node })), pageInfo });
const ticket = z.object({
  id: z.uuid(),
  subject: z.string(),
  customerEmail: z.email(),
  status: ticketStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ticketsSchema = z.object({ tickets: connection(ticket) });
export const documentsSchema = z.object({
  knowledgeDocuments: connection(
    z.object({
      id: z.uuid(),
      title: z.string(),
      status: z.enum(['queued', 'processing', 'indexed', 'failed', 'superseded']),
      activeVersionId: z.uuid().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export const searchSchema = z.object({
  knowledgeSearch: connection(
    z.object({
      chunkId: z.uuid(),
      documentId: z.uuid(),
      versionId: z.uuid(),
      title: z.string(),
      excerpt: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export const draftSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  text: z.string(),
  status: draftStatusSchema,
  revision: z.number().int(),
  evidenceValidated: z.boolean(),
  humanEdited: z.boolean(),
  originalText: z.string().nullable(),
  editedBy: z.uuid().nullable(),
  editedAt: z.string().nullable(),
  model: z.string(),
  promptVersion: z.string(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.string().nullable(),
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
  citations: z.array(
    z.object({
      documentId: z.uuid(),
      versionId: z.uuid(),
      chunkId: z.uuid(),
      quote: z.string().nullish(),
      reference: z.string().nullish(),
    }),
  ),
  generation: z
    .object({
      outcome: z.string(),
      abstentionReason: z.string().nullish(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      estimatedCostUsd: z.number(),
      usageIncomplete: z.boolean(),
      provider: z.string(),
      totalLatencyMs: z.number(),
    })
    .nullish(),
});
export const reviewQueueSchema = z.object({ reviewQueue: connection(draftSchema) });
export const workspaceDraftSchema = z.object({ draft: draftSchema.nullable() });
export const messageSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  author: z.string(),
  deliveryStatus: z.string(),
  sourceDraftId: z.uuid().nullable(),
  createdAt: z.string(),
});
export const workspaceTicketSchema = z.object({
  ticket: ticket
    .extend({
      messageHistory: connection(messageSchema),
      drafts: z.array(
        z.object({
          id: z.uuid(),
          text: z.string(),
          status: draftStatusSchema,
          revision: z.number().int(),
          humanEdited: z.boolean(),
          createdAt: z.string(),
        }),
      ),
    })
    .nullable(),
});
export const summarySchema = z.object({
  dashboardSummary: z.object({
    openTickets: z.number(),
    pendingTickets: z.number(),
    resolvedTickets: z.number(),
    publishedDocuments: z.number(),
    pendingReviews: z.number(),
    acceptedJobs: z.number(),
    failedJobs: z.number(),
  }),
});
export const jobsSchema = z.object({
  backgroundJobs: connection(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      status: jobStatusSchema,
      resourceId: z.uuid().nullable(),
      attempts: z.number(),
      reasonCode: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
export type WorkspaceIdentity = z.infer<typeof identitySchema>;
