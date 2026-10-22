import { aiFailureMessage } from '@resolvehub/contracts';
import { BackgroundJobsDocument } from '@resolvehub/generated';
import { graph, workspaceClient } from '@/lib/workspace-api';
import { jobsSchema } from '@/lib/workspace-schemas';
import { ActionForm } from './action-form';
import { replayJob } from '@/lib/actions';
import { Pager, StatusPill, Stamp, WorkspaceIssue } from './workspace-ui';
async function Failure({ id, admin, kind }: { id: string; admin: boolean; kind: string }) {
  const client = await workspaceClient();
  const result = await client.GET('/v1/jobs/{id}/failure', {
    params: { path: { id } },
    signal: AbortSignal.timeout(5000),
  });
  if (result.error || !result.data)
    return <p>Failure details are unavailable. Check the service and retry.</p>;
  const failure = result.data;
  return (
    <details className="failure-details">
      <summary>Failure details and replay</summary>
      <p>
        {failure.errorCategory}:{' '}
        {kind === 'draft_response' ? aiFailureMessage(failure.errorCategory) : failure.summary}
      </p>
      <p className="muted">
        Request {failure.requestId} · Job {id}
      </p>
      <ol>
        {failure.attemptHistory.map((a) => (
          <li key={a.attempt}>
            Attempt {a.attempt} · {a.stage} · {a.outcome}
            {a.errorCategory ? ` · ${a.errorCategory}` : ''}
          </li>
        ))}
      </ol>
      {admin && failure.replayEligible ? (
        <ActionForm action={replayJob} label="Replay failed job">
          <input type="hidden" name="jobId" value={id} />
          <input type="hidden" name="kind" value={kind} />
        </ActionForm>
      ) : (
        <p className="muted">
          {!admin
            ? 'An administrator must authorize replay.'
            : failure.replayedAs
              ? 'This failure has already been replayed.'
              : 'This failure is not eligible for replay.'}
        </p>
      )}
    </details>
  );
}
export async function BackgroundJobs({ admin, after }: { admin: boolean; after?: string }) {
  try {
    const data = await graph(
      BackgroundJobsDocument,
      { first: 10, after: after ?? null },
      jobsSchema,
    );
    return (
      <section className="content-card" id="jobs">
        <h2>Background processing</h2>
        <p>
          Durable ingestion and drafting jobs for your organization. Failed jobs retain their
          attempt history.
        </p>
        <div className="job-list">
          {data.backgroundJobs.edges.map(({ node: j }) => (
            <article key={j.id}>
              <div className="row-between">
                <strong>{j.kind.replaceAll('_', ' ')}</strong>
                <StatusPill status={j.status} />
              </div>
              <p className="muted">
                {j.attempts} attempts · <Stamp value={j.createdAt} />
              </p>
              {j.reasonCode && <p>{j.reasonCode}</p>}
              {j.status === 'failed' && <Failure id={j.id} admin={admin} kind={j.kind} />}
            </article>
          ))}
          {!data.backgroundJobs.edges.length && <p>No background jobs yet.</p>}
        </div>
        <Pager base="/settings" info={data.backgroundJobs.pageInfo} />
      </section>
    );
  } catch (error) {
    return <WorkspaceIssue error={error} />;
  }
}
