import Link from 'next/link';
import { ReviewQueueDocument } from '@resolvehub/generated';
import { graph } from '@/lib/workspace-api';
import { reviewQueueSchema, draftStatusSchema } from '@/lib/workspace-schemas';
import {
  PageHeading,
  workspaceAccess,
  AccessPanel,
  WorkspaceIssue,
  StatusPill,
  Pager,
  Stamp,
} from '@/components/workspace-ui';
export const metadata = { title: 'Review Queue' };
export default async function Review({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const heading = (
    <PageHeading
      title="Review Queue"
      description="Verify the evidence, refine the wording and decide what belongs in the conversation."
    />
  );
  const access = await workspaceAccess();
  if (access.kind !== 'connected')
    return (
      <div className="page-content">
        {heading}
        <AccessPanel access={access} />
      </div>
    );
  try {
    const params = await searchParams;
    const status = draftStatusSchema.parse(params.status ?? 'pending');
    const data = await graph(
      ReviewQueueDocument,
      { first: 20, after: params.after ?? null, status },
      reviewQueueSchema,
    );
    return (
      <div className="page-content">
        {heading}
        <div className="workflow-note">
          Human approval records an internal reply. It never marks a response as externally
          delivered.
        </div>
        <section className="list-panel">
          <div className="list-heading">
            <div>
              <h2>Support drafts</h2>
              <p>Pending decisions and previous reviews for your organization.</p>
            </div>
            <Link className="secondary-button" href={`/review?status=${status}`}>
              Refresh queue
            </Link>
          </div>
          <form className="filter-form">
            <label>
              Review status
              <select name="status" defaultValue={status}>
                <option value="pending">Awaiting review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <button className="secondary-button">Apply filter</button>
          </form>
          <div className="review-cards">
            {data.reviewQueue.edges.map(({ node: d }) => (
              <article className="review-card" key={d.id}>
                <div className="row-between">
                  <StatusPill status={d.status} />
                  <Stamp value={d.createdAt} />
                </div>
                <h3>
                  {d.generation?.outcome === 'insufficient_evidence'
                    ? 'Insufficient evidence — needs attention'
                    : 'Cited support response'}
                </h3>
                <p className="draft-preview preserve-text">{d.text}</p>
                <div className="row-between">
                  <span className="muted">
                    {d.citations.length} source{d.citations.length === 1 ? '' : 's'} · Revision{' '}
                    {d.revision}
                    {d.humanEdited ? ' · Agent edited' : ''}
                  </span>
                  <Link className="text-link" href={`/review/${d.id}`}>
                    Open review →
                  </Link>
                </div>
              </article>
            ))}
            {!data.reviewQueue.edges.length && (
              <div className="record-empty">
                <h3>No {status} drafts</h3>
                <p>Generate a support draft from a ticket to begin a review.</p>
                <Link className="text-link" href="/tickets">
                  Open tickets →
                </Link>
              </div>
            )}
          </div>
          <Pager base="/review" info={data.reviewQueue.pageInfo} values={{ status }} />
        </section>
      </div>
    );
  } catch (error) {
    return (
      <div className="page-content">
        {heading}
        <WorkspaceIssue error={error} />
      </div>
    );
  }
}
