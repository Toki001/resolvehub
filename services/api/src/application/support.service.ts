import { createHash } from 'node:crypto';
import { UploadsService } from './uploads.service.js';
import { REPLY_DELIVERY } from '../delivery/reply-delivery.js';
import type { ReplyDelivery } from '../delivery/reply-delivery.js';
import { Inject, Injectable } from '@nestjs/common';
import { StoreConflict } from '@resolvehub/db';
import type { Actor, MutationReceipt, TenantRepository } from '@resolvehub/db';
import type { components } from '@resolvehub/generated';
import { z } from 'zod';
import { DatabaseService } from './database.service.js';
import { ContractValidator } from './validator.js';
import { ApiFault, notFound, unavailable } from './fault.js';
import { Pagination } from './pagination.js';
import { idempotencyKey, requireWriteAccess } from './policy.js';
import { fingerprint } from '../auth/crypto.js';
import type { Identity } from '../auth/context.js';

type Schemas = components['schemas'];

const filterSchema = z
  .object({
    status: z.enum(['open', 'pending', 'resolved']).nullish(),
    query: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();
const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.enum(['queued', 'processing', 'indexed', 'failed', 'superseded']),
  activeVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
const matchSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  versionId: z.uuid(),
  title: z.string(),
  excerpt: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
const summarySchema = z.object({
  openTickets: z.number().int().nonnegative(),
  pendingTickets: z.number().int().nonnegative(),
  resolvedTickets: z.number().int().nonnegative(),
  publishedDocuments: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
  acceptedJobs: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
});

@Injectable()
export class SupportService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ContractValidator) private readonly validator: ContractValidator,
    @Inject(Pagination) private readonly pagination: Pagination,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(REPLY_DELIVERY) private readonly delivery: ReplyDelivery,
  ) {}

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiFault) throw error;
      if (error instanceof z.ZodError)
        throw new ApiFault(500, 'INTERNAL_ERROR', 'Stored data violated its contract.');
      if (error instanceof StoreConflict) {
        if (error.kind === 'capacity')
          throw new ApiFault(429, 'CAPACITY_EXCEEDED', 'Ingestion capacity is full. Retry later.');
        if (error.kind === 'not_found') throw notFound();
        if (error.kind === 'evidence')
          throw new ApiFault(
            422,
            'INVALID_CONTENT',
            'Draft evidence is not eligible for approval.',
          );
        throw new ApiFault(
          409,
          'CONFLICT',
          error.kind === 'idempotency'
            ? 'Idempotency key was already used for a different request.'
            : 'Resource state or revision conflicts with this action.',
        );
      }
      throw unavailable();
    }
  }

  private mutate(
    actor: Actor,
    key: unknown,
    scope: string,
    input: unknown,
    action: (repository: TenantRepository) => Promise<MutationReceipt>,
  ) {
    const validatedKey = idempotencyKey.parse(key);
    return this.execute(() =>
      this.database.store.mutate(actor, validatedKey, scope, fingerprint(input), action),
    );
  }
  actor(identity: Identity, requestId: string): Actor {
    return {
      organizationId: identity.organizationId,
      actorId: identity.membershipId,
      actorKind: 'membership',
      requestId,
    };
  }
  private accepted(jobId: string, requestId: string): MutationReceipt {
    const body = this.validator.validate(
      'AcceptedJob',
      { jobId, requestId, status: 'accepted', statusUrl: `/v1/jobs/${jobId}` },
      true,
    );
    return { status: 202, body, location: body.statusUrl };
  }

  createTicket(
    identity: Identity,
    requestId: string,
    key: unknown,
    input: Schemas['CreateTicketInput'],
  ) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, 'POST /v1/tickets', input, async (repository) => {
      const body = this.validator.validate('Ticket', await repository.createTicket(input), true);
      await repository.audit(actor, 'ticket.created', body.id);
      return { status: 201, body };
    });
  }

  ingestion(
    identity: Identity,
    requestId: string,
    key: unknown,
    input: Schemas['IngestionInput'] | Schemas['DocumentVersionInput'],
    documentId?: string,
  ) {
    requireWriteAccess(identity);
    if (!input.objectKey.startsWith(`organizations/${identity.organizationId}/uploads/`))
      throw new ApiFault(403, 'FORBIDDEN', 'Object namespace is not accessible.');
    const actor = this.actor(identity, requestId);
    return this.mutate(
      actor,
      key,
      documentId ? `POST /v1/documents/${documentId}/versions` : 'POST /v1/documents/ingestions',
      input,
      async (repository) => {
        await repository.reserveIngestion();
        const document = await repository.createIngestion(input, documentId);
        const jobId = await repository.createJob(
          'document_ingestion',
          document.documentId,
          document,
          requestId,
          null,
          identity.membershipId,
        );
        await repository.audit(actor, 'ingestion.accepted', jobId);
        return this.accepted(jobId, requestId);
      },
    );
  }

  requestDraft(identity: Identity, requestId: string, key: unknown, id: string) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/tickets/${id}/drafts`, {}, async (repository) => {
      if (!(await repository.ticket(id))) throw notFound();
      const jobId = await repository.createJob(
        'draft_response',
        id,
        { ticketId: id },
        requestId,
        null,
        identity.membershipId,
      );
      await repository.audit(actor, 'draft.requested', jobId);
      return this.accepted(jobId, requestId);
    });
  }

  review(
    identity: Identity,
    requestId: string,
    key: unknown,
    id: string,
    action: 'approve' | 'reject',
    input: Schemas['ApproveDraftInput'] | Schemas['RejectDraftInput'],
  ) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/drafts/${id}/${action}`, input, async (repository) => {
      const record = await repository.draft(id, true);
      if (!record) throw notFound();
      const draft = this.validator.validate('Draft', record, true);
      if (draft.status !== 'pending' || draft.revision !== input.expectedRevision)
        throw new StoreConflict('state');
      if (action === 'approve') {
        if (
          draft.humanEdited &&
          (!('acknowledgeEdits' in input) || input.acknowledgeEdits !== true)
        )
          throw new ApiFault(
            422,
            'INVALID_CONTENT',
            'Review and acknowledge the edited wording before approval.',
          );
        if (
          !draft.evidenceValidated ||
          draft.citations.length === 0 ||
          (draft.generation && draft.generation.outcome !== 'answer')
        )
          throw new StoreConflict('evidence');
        for (const citation of draft.citations) {
          if (!(await repository.activeCitation(citation))) throw new StoreConflict('evidence');
        }
      }
      const reason = 'reason' in input ? input.reason : null;
      const body = this.validator.validate(
        'Draft',
        await repository.review(
          id,
          action === 'approve' ? 'approved' : 'rejected',
          identity.membershipId,
          reason,
        ),
        true,
      );
      if (action === 'approve') await this.delivery.stage(repository, id, actor);
      await repository.audit(actor, `draft.${body.status}`, id);
      return { status: 200, body };
    });
  }

  editDraft(
    identity: Identity,
    requestId: string,
    key: unknown,
    id: string,
    input: Schemas['EditDraftInput'],
  ) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/drafts/${id}/edits`, input, async (repository) => {
      const record = await repository.draft(id, true);
      if (!record) throw notFound();
      const draft = this.validator.validate('Draft', record, true);
      if (draft.status !== 'pending' || draft.revision !== input.expectedRevision)
        throw new StoreConflict('state');
      const body = this.validator.validate(
        'Draft',
        await repository.editDraft(id, input.text, identity.membershipId),
        true,
      );
      await repository.audit(actor, 'draft.edited', id);
      return { status: 200, body };
    });
  }
  upload(identity: Identity, requestId: string, key: unknown, input: unknown, mediaType: unknown) {
    requireWriteAccess(identity);
    const bytes = z
      .instanceof(Buffer)
      .refine((v) => v.length > 0 && v.length <= 10485760)
      .parse(input);
    const type = z.enum(['text/plain', 'text/markdown', 'application/pdf']).parse(mediaType);
    const validatedKey = idempotencyKey.parse(key);
    const actor = this.actor(identity, requestId);
    return this.mutate(
      actor,
      validatedKey,
      'POST /v1/documents/uploads',
      {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        mediaType: type,
      },
      async (repository) => {
        const body = this.validator.validate(
          'UploadedDocument',
          await this.uploads.put(identity.organizationId, validatedKey, bytes, type),
          true,
        );
        await repository.audit(actor, 'document.uploaded', identity.membershipId);
        return { status: 201, body };
      },
    );
  }
  changeTicketStatus(
    identity: Identity,
    requestId: string,
    key: unknown,
    id: string,
    input: Schemas['ChangeTicketStatusInput'],
  ) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/tickets/${id}/status`, input, async (repository) => {
      const body = this.validator.validate(
        'Ticket',
        await repository.changeTicketStatus(id, input.expectedStatus, input.event),
        true,
      );
      await repository.audit(actor, 'ticket.status_changed', id);
      return { status: 200, body };
    });
  }
  customerMessage(
    identity: Identity,
    requestId: string,
    key: unknown,
    id: string,
    input: Schemas['CustomerMessageInput'],
  ) {
    requireWriteAccess(identity);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/tickets/${id}/messages`, input, async (repository) => {
      const body = this.validator.validate(
        'Message',
        await repository.recordCustomerMessage(id, input.body),
        true,
      );
      await repository.audit(actor, 'ticket.customer_message_recorded', body.id);
      return { status: 201, body };
    });
  }
  async reviewQueue(
    identity: Identity,
    first?: number | null,
    after?: string | null,
    status?: unknown,
  ) {
    const filter = {
      status: z.enum(['pending', 'approved', 'rejected']).parse(status ?? 'pending'),
    };
    const window = this.pagination.window(
      identity.organizationId,
      'review-queue',
      filter,
      first,
      after,
    );
    return this.execute(async () =>
      window.connection(
        (
          await this.database.store
            .tenant(identity.organizationId)
            .reviewQueue(window.page, filter.status)
        ).map((row) => this.validator.validate('Draft', row, true)),
        (row) => row.id,
      ),
    );
  }
  async backgroundJobs(
    identity: Identity,
    first?: number | null,
    after?: string | null,
    status?: unknown,
  ) {
    const filter = {
      status:
        z
          .enum(['accepted', 'processing', 'succeeded', 'failed', 'cancelled'])
          .nullish()
          .parse(status) ?? undefined,
    };
    const window = this.pagination.window(
      identity.organizationId,
      'background-jobs',
      filter,
      first,
      after,
    );
    return this.execute(async () =>
      window.connection(
        (
          await this.database.store
            .tenant(identity.organizationId)
            .backgroundJobs(window.page, filter.status)
        ).map((row) => this.validator.validate('Job', row, true)),
        (row) => row.id,
      ),
    );
  }
  async messageHistory(
    identity: Identity,
    ticketId: string,
    first?: number | null,
    after?: string | null,
  ) {
    const window = this.pagination.window(
      identity.organizationId,
      `messages:${ticketId}`,
      {},
      first,
      after,
    );
    return this.execute(async () =>
      window.connection(
        (
          await this.database.store
            .tenant(identity.organizationId)
            .messageHistory(ticketId, window.page)
        ).map((row) => this.validator.validate('Message', row, true)),
        (row) => row.id,
      ),
    );
  }

  replay(identity: Identity, requestId: string, key: unknown, id: string) {
    requireWriteAccess(identity, true);
    const actor = this.actor(identity, requestId);
    return this.mutate(actor, key, `POST /v1/jobs/${id}/replay`, {}, async (repository) => {
      const jobId = await repository.replay(id, requestId, identity.membershipId);
      await repository.audit(actor, 'job.replayed', jobId);
      return this.accepted(jobId, requestId);
    });
  }

  webhook(actor: Actor, integrationId: string, input: Schemas['WebhookTicketInput']) {
    const key = `wh_${fingerprint({ integrationId, eventId: input.eventId })}`;
    return this.mutate(actor, key, `WEBHOOK ${integrationId}`, input, async (repository) => {
      const jobId = await repository.createJob('ticket_webhook', null, input, actor.requestId);
      await repository.audit(actor, 'webhook.accepted', jobId);
      return this.accepted(jobId, actor.requestId);
    });
  }

  async failure(identity: Identity, id: string) {
    return this.execute(async () => {
      const failure = await this.database.store.tenant(identity.organizationId).failure(id);
      if (!failure) throw notFound();
      return this.validator.validate('FailedJob', failure, true);
    });
  }

  async job(identity: Identity, id: string) {
    return this.execute(async () => {
      const job = await this.database.store.tenant(identity.organizationId).job(id);
      if (!job) throw notFound();
      return this.validator.validate('Job', job, true);
    });
  }

  async ticket(identity: Identity, id: string) {
    return this.execute(async () => {
      const ticket = await this.database.store.tenant(identity.organizationId).ticket(id);
      if (!ticket) throw notFound();
      return this.validator.validate('Ticket', ticket, true);
    });
  }

  async tickets(
    identity: Identity,
    first?: number | null,
    after?: string | null,
    filter?: unknown,
  ) {
    const parsed = filterSchema.parse(filter ?? {});
    const normalized = {
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.query ? { query: parsed.query } : {}),
    };
    const window = this.pagination.window(
      identity.organizationId,
      'tickets',
      normalized,
      first,
      after,
    );
    return this.execute(async () =>
      window.connection(
        (
          await this.database.store.tenant(identity.organizationId).tickets(window.page, normalized)
        ).map((row) => this.validator.validate('Ticket', row, true)),
        (row) => row.id,
      ),
    );
  }

  async messages(identity: Identity, ticketId: string) {
    return this.execute(async () =>
      (await this.database.store.tenant(identity.organizationId).messages(ticketId)).map((row) =>
        this.validator.validate('Message', row, true),
      ),
    );
  }
  async drafts(identity: Identity, ticketId: string) {
    return this.execute(async () =>
      (await this.database.store.tenant(identity.organizationId).drafts(ticketId)).map((row) =>
        this.validator.validate('Draft', row, true),
      ),
    );
  }
  async draft(identity: Identity, id: string) {
    return this.execute(async () => {
      const draft = await this.database.store.tenant(identity.organizationId).draft(id);
      if (!draft) throw notFound();
      return this.validator.validate('Draft', draft, true);
    });
  }
  async documents(identity: Identity, first?: number | null, after?: string | null) {
    const window = this.pagination.window(identity.organizationId, 'documents', {}, first, after);
    return this.execute(async () =>
      window.connection(
        (await this.database.store.tenant(identity.organizationId).documents(window.page)).map(
          (row) => documentSchema.parse(row),
        ),
        (row) => row.id,
      ),
    );
  }
  async search(identity: Identity, query: string, first?: number | null, after?: string | null) {
    const normalized = z.string().trim().min(1).max(200).parse(query);
    const window = this.pagination.window(
      identity.organizationId,
      'knowledge-search',
      { query: normalized },
      first,
      after,
    );
    return this.execute(async () =>
      window.connection(
        (
          await this.database.store.tenant(identity.organizationId).search(normalized, window.page)
        ).map((row) => matchSchema.parse(row)),
        (row) => row.chunkId,
      ),
    );
  }
  async summary(identity: Identity) {
    return this.execute(async () =>
      summarySchema.parse(await this.database.store.tenant(identity.organizationId).summary()),
    );
  }
}
