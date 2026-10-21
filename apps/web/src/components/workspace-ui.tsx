import Link from 'next/link';
import type { ReactNode } from 'react';
import { WorkspaceError, sessionIdentity } from '@/lib/workspace-api';

export async function workspaceAccess() {
  try {
    const identity = await sessionIdentity();
    return identity ? { kind: 'connected' as const, identity } : { kind: 'signed_out' as const };
  } catch (error) {
    return { kind: 'unavailable' as const, error };
  }
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">RESOLVEHUB SUPPORT WORKSPACE</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function AccessPanel({ access }: { access: Awaited<ReturnType<typeof workspaceAccess>> }) {
  return access.kind === 'unavailable' ? (
    <WorkspaceIssue error={access.error} />
  ) : (
    <section className="content-card connect-card">
      <h2>Connect your workspace</h2>
      <p>Sign in to access your organization’s tickets, knowledge and reviewed replies.</p>
      <Link className="primary-button" href="/sign-in">
        Sign in
      </Link>
    </section>
  );
}
export function WorkspaceIssue({ error }: { error: unknown }) {
  return (
    <section className="content-card" role="alert">
      <h2>Workspace data is unavailable</h2>
      <p>
        {error instanceof WorkspaceError
          ? error.message
          : 'The support service could not complete this request. Please try again.'}
      </p>
      {error instanceof WorkspaceError && error.requestId && <p>Reference: {error.requestId}</p>}
      <Link className="text-link" href="/settings#health">
        Check service health →
      </Link>
    </section>
  );
}
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`status-pill ${['open', 'pending', 'resolved', 'approved', 'rejected', 'failed', 'indexed', 'processing', 'queued', 'accepted', 'succeeded', 'cancelled', 'superseded'].includes(status) ? status : ''}`}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}
export function Pager({
  base,
  info,
  values = {},
}: {
  base: string;
  info: { hasNextPage: boolean; endCursor?: string | null };
  values?: Record<string, string>;
}) {
  const next = new URLSearchParams(values);
  if (info.endCursor) next.set('after', info.endCursor);
  const newest = new URLSearchParams(values);
  newest.delete('after');
  return (
    <nav className="pagination" aria-label="Pagination">
      <Link className="secondary-button" href={`${base}?${newest}`}>
        Back to newest
      </Link>
      {info.hasNextPage && info.endCursor && (
        <Link className="secondary-button" href={`${base}?${next}`}>
          Next page →
        </Link>
      )}
    </nav>
  );
}
export function Stamp({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value))}{' '}
      UTC
    </time>
  );
}
