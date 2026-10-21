'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  workspaceClient,
  apiError,
  assertActionOrigin,
  WorkspaceError,
} from './workspace-api';
import { localDemoAllowed } from './action-policy';
import { identitySchema, ticketStatusSchema } from './workspace-schemas';

export interface ActionResult {
  error?: string;
  success?: string;
  navigateTo?: string;
  jobId?: string;
  jobKind?: 'document_ingestion' | 'draft_response';
}
async function handle(operation: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    await assertActionOrigin();
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceError)
      return {
        error: `${error.message}${error.requestId ? ` Reference: ${error.requestId}` : ''}`,
      };
    if (error instanceof z.ZodError)
      return { error: 'Please check the form fields and try again.' };
    return {
      error:
        'The support service is unavailable. Your changes have not been confirmed; retry with the same form.',
    };
  }
}
function read(form: FormData, key: string) {
  return z.string().parse(form.get(key));
}
function options(form: FormData) {
  const header = {
    'Idempotency-Key': z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,110}$/)
      .parse(form.get('idempotencyKey')),
  };
  return {
    headers: header,
    params: { header },
    cache: 'no-store' as const,
    signal: AbortSignal.timeout(10000),
  };
}
function value<T>(result: { data?: T; error?: unknown }) {
  if (result.error) throw apiError(result.error);
  if (result.data === undefined) throw apiError(undefined);
  return result.data;
}
function refresh() {
  revalidatePath('/', 'layout');
}
async function establish(token: string): Promise<ActionResult> {
  const valid = z
    .string()
    .regex(/^rh_[A-Za-z0-9_-]{43}$/)
    .parse(token.trim());
  const client = await workspaceClient(valid);
  identitySchema.parse(value(await client.GET('/v1/me', { signal: AbortSignal.timeout(5000) })));
  const origin = new URL((await headers()).get('origin') ?? '');
  if (
    process.env.NODE_ENV === 'production' &&
    origin.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(origin.hostname)
  )
    throw new WorkspaceError('FORBIDDEN', 'HTTPS is required to sign in.');
  (await cookies()).set(SESSION_COOKIE, valid, {
    httpOnly: true,
    secure: origin.protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 3600,
  });
  refresh();
  return { navigateTo: '/tickets' };
}
export async function signIn(_previous: ActionResult, form: FormData) {
  return handle(() => establish(read(form, 'accessKey')));
}
export async function localSignIn(_previous: ActionResult, _form: FormData) {
  return handle(async () => {
    if (!localDemoAllowed(process.env, (await headers()).get('host')))
      throw new WorkspaceError('FORBIDDEN', 'Local demo access is not enabled.');
    return establish(process.env.DASHBOARD_LOCAL_DEMO_TOKEN ?? '');
  });
}
export async function signOut(_previous: ActionResult, _form: FormData): Promise<ActionResult> {
  const result = await handle(async () => {
    (await cookies()).delete(SESSION_COOKIE);
    refresh();
    return {};
  });
  if (result.error) return result;
  redirect('/sign-in');
}
export async function createTicket(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    const ticket = value(
      await client.POST('/v1/tickets', {
        ...options(form),
        body: {
          subject: read(form, 'subject'),
          customerEmail: read(form, 'customerEmail'),
          message: read(form, 'message'),
        },
      }),
    );
    refresh();
    return { navigateTo: `/tickets/${ticket.id}` };
  });
}
export async function requestDraft(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    const receipt = value(
      await client.POST('/v1/tickets/{id}/drafts', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('ticketId')) },
        },
      }),
    );
    return {
      success: 'Drafting started. The response will require human review.',
      jobId: receipt.jobId,
      jobKind: 'draft_response',
    };
  });
}
export async function editDraft(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    value(
      await client.POST('/v1/drafts/{id}/edits', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('draftId')) },
        },
        body: {
          text: read(form, 'text'),
          expectedRevision: z.coerce.number().int().positive().parse(form.get('revision')),
        },
      }),
    );
    refresh();
    return { success: 'Changes saved. Review the edited wording before approval.' };
  });
}
export async function approveDraft(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    value(
      await client.POST('/v1/drafts/{id}/approve', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('draftId')) },
        },
        body: {
          expectedRevision: z.coerce.number().int().positive().parse(form.get('revision')),
          acknowledgeEdits: form.get('acknowledgeEdits') === 'on',
        },
      }),
    );
    refresh();
    return {
      success: 'Approved reply recorded in the conversation. Internal only; no external delivery.',
    };
  });
}
export async function rejectDraft(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    value(
      await client.POST('/v1/drafts/{id}/reject', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('draftId')) },
        },
        body: {
          expectedRevision: z.coerce.number().int().positive().parse(form.get('revision')),
          reason: read(form, 'reason'),
        },
      }),
    );
    refresh();
    return { success: 'Draft rejected. The reason is saved in its review history.' };
  });
}
export async function changeStatus(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    value(
      await client.POST('/v1/tickets/{id}/status', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('ticketId')) },
        },
        body: {
          expectedStatus: ticketStatusSchema.parse(form.get('expectedStatus')),
          event: z.enum(['wait', 'resolve', 'reopen']).parse(form.get('event')),
        },
      }),
    );
    refresh();
    return { success: 'Ticket status updated.' };
  });
}
export async function recordCustomerMessage(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    value(
      await client.POST('/v1/tickets/{id}/messages', {
        ...options(form),
        params: {
          header: options(form).headers,
          path: { id: z.uuid().parse(form.get('ticketId')) },
        },
        body: { body: read(form, 'body') },
      }),
    );
    refresh();
    return { success: 'Customer message recorded.' };
  });
}
export async function uploadDocument(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > 10485760)
      throw new WorkspaceError(
        'INVALID_INPUT',
        'Choose a nonempty PDF, text or Markdown file up to 10 MiB.',
      );
    const extension = file.name.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      pdf: 'application/pdf',
      md: 'text/markdown',
      txt: 'text/plain',
    };
    const mediaType = z
      .enum(['text/plain', 'text/markdown', 'application/pdf'])
      .parse(types[extension ?? '']);
    const base = options(form);
    const bytes = await file.arrayBuffer();
    const uploaded = value(
      await client.POST('/v1/documents/uploads', {
        ...base,
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        params: {
          header: {
            'Idempotency-Key': `${base.headers['Idempotency-Key']}_upload`,
            'X-Document-Type': mediaType,
          },
        },
        body: '',
        bodySerializer: () => bytes,
      }),
    );
    const documentId = form.get('documentId');
    let receipt;
    if (typeof documentId === 'string' && documentId) {
      receipt = value(
        await client.POST('/v1/documents/{id}/versions', {
          ...base,
          headers: { 'Idempotency-Key': `${base.headers['Idempotency-Key']}_index` },
          params: {
            header: { 'Idempotency-Key': `${base.headers['Idempotency-Key']}_index` },
            path: { id: z.uuid().parse(documentId) },
          },
          body: uploaded,
        }),
      );
    } else {
      receipt = value(
        await client.POST('/v1/documents/ingestions', {
          ...base,
          headers: { 'Idempotency-Key': `${base.headers['Idempotency-Key']}_index` },
          params: { header: { 'Idempotency-Key': `${base.headers['Idempotency-Key']}_index` } },
          body: { ...uploaded, title: read(form, 'title') },
        }),
      );
    }
    refresh();
    return {
      success: 'Upload staged. The background worker is validating and indexing it.',
      jobId: receipt.jobId,
      jobKind: 'document_ingestion',
    };
  });
}
export async function replayJob(_previous: ActionResult, form: FormData) {
  return handle(async () => {
    const client = await workspaceClient();
    const receipt = value(
      await client.POST('/v1/jobs/{id}/replay', {
        ...options(form),
        params: { header: options(form).headers, path: { id: z.uuid().parse(form.get('jobId')) } },
      }),
    );
    refresh();
    return {
      success: 'Replay accepted after authorization.',
      jobId: receipt.jobId,
      jobKind: form.get('kind') === 'draft_response' ? 'draft_response' : 'document_ingestion',
    };
  });
}
