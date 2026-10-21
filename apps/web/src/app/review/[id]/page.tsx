import Link from 'next/link';
import { z } from 'zod';
import { WorkspaceDraftDocument } from '@resolvehub/generated';
import { graph } from '@/lib/workspace-api';
import { workspaceDraftSchema } from '@/lib/workspace-schemas';
import { editDraft, approveDraft, rejectDraft } from '@/lib/actions';
import { ActionForm } from '@/components/action-form';
import {
  PageHeading,
  workspaceAccess,
  AccessPanel,
  WorkspaceIssue,
  StatusPill,
  Stamp,
} from '@/components/workspace-ui';
export const metadata = { title: 'Review support draft' };
export default async function ReviewDraft({ params }: { params: Promise<{ id: string }> }) {
  const access = await workspaceAccess();
  if (access.kind !== 'connected')
    return (
      <div className="page-content">
        <PageHeading title="Review draft" description="Sign in to review this response." />
        <AccessPanel access={access} />
      </div>
    );
  try {
    const id = z.uuid().parse((await params).id);
    const { draft } = await graph(WorkspaceDraftDocument, { id }, workspaceDraftSchema);
    if (!draft)
      return (
        <div className="page-content">
          <h1>Draft not found</h1>
          <Link href="/review">Return to review queue</Link>
        </div>
      );
    const editable = access.identity.role !== 'analyst' && draft.status === 'pending';
    const eligible =
      draft.evidenceValidated &&
      draft.citations.length > 0 &&
      (!draft.generation || draft.generation.outcome === 'answer');
    return (
      <div className="page-content">
        <Link className="back-link" href="/review">
          ← Review queue
        </Link>
        <PageHeading title="Review support draft" description="Human judgment has the final say.">
          <StatusPill status={draft.status} />
        </PageHeading>
        <div className="workflow-note">
          Approved replies stay inside ResolveHub. No SMTP or outbound webhook is configured.
        </div>
        <div className="detail-grid">
          <div>
            <section className="content-card">
              <div className="row-between">
                <h2>Response wording</h2>
                <span className="subtle-label">Revision {draft.revision}</span>
              </div>
              {draft.humanEdited && (
                <p className="review-warning">
                  Edited by an agent. The quotations below identify the original evidence; review
                  all edited wording before approval.
                </p>
              )}
              {editable ? (
                <ActionForm action={editDraft} label="Save draft changes" reset={false}>
                  <input type="hidden" name="draftId" value={id} />
                  <input type="hidden" name="revision" value={draft.revision} />
                  <label>
                    Draft text
                    <textarea
                      name="text"
                      required
                      maxLength={20000}
                      defaultValue={draft.text}
                      rows={12}
                    />
                  </label>
                </ActionForm>
              ) : (
                <p className="preserve-text draft-body">{draft.text}</p>
              )}
              {draft.originalText && (
                <details className="source-details">
                  <summary>Original generated wording</summary>
                  <p className="preserve-text">{draft.originalText}</p>
                </details>
              )}
            </section>
            <section className="content-card">
              <h2>Evidence and citations</h2>
              <p>
                Verify the source quotations against the response. Approval checks that these
                versions are still published.
              </p>
              {draft.citations.map((c, i) => (
                <blockquote className="citation" key={c.chunkId}>
                  <strong>{c.reference ?? `[${i + 1}]`}</strong>
                  <p className="preserve-text">
                    {c.quote ??
                      'This legacy citation has no stored quotation. Review the source before approval.'}
                  </p>
                  <details>
                    <summary>Evidence identifiers</summary>
                    <dl className="metadata-list">
                      <dt>Document version</dt>
                      <dd>{c.versionId}</dd>
                      <dt>Chunk</dt>
                      <dd>{c.chunkId}</dd>
                    </dl>
                  </details>
                </blockquote>
              ))}
              {!draft.citations.length && (
                <p className="review-warning">
                  No verified evidence is available. This response cannot be approved. Add relevant
                  knowledge and generate another draft, or reject it with a reason.
                </p>
              )}
            </section>
          </div>
          <aside>
            <section className="content-card">
              <h2>Human review</h2>
              <Link className="text-link" href={`/tickets/${draft.ticketId}`}>
                Open ticket conversation →
              </Link>
              {editable ? (
                <>
                  <ActionForm
                    action={approveDraft}
                    label="Approve & add to conversation"
                    disabled={!eligible}
                  >
                    <input type="hidden" name="draftId" value={id} />
                    <input type="hidden" name="revision" value={draft.revision} />
                    <label className="checkbox-label">
                      <input type="checkbox" name="acknowledgeEdits" required />I reviewed the saved
                      wording and evidence. Record this reply internally.
                    </label>
                  </ActionForm>
                  {!eligible && (
                    <p className="muted">
                      Approval requires an answer with verified, current evidence.
                    </p>
                  )}
                  <details className="reject-panel">
                    <summary>Reject this draft</summary>
                    <ActionForm action={rejectDraft} label="Reject draft">
                      <input type="hidden" name="draftId" value={id} />
                      <input type="hidden" name="revision" value={draft.revision} />
                      <label>
                        Rejection reason
                        <textarea name="reason" required maxLength={1000} rows={4} />
                      </label>
                    </ActionForm>
                  </details>
                </>
              ) : (
                <div className="review-history">
                  <p>
                    {draft.status === 'approved'
                      ? 'Approved for internal use. Review the ticket conversation for reply history.'
                      : draft.status === 'rejected'
                        ? 'This draft was rejected. No reply was recorded.'
                        : 'Your membership is read-only.'}
                  </p>
                  {draft.reviewReason && (
                    <p className="preserve-text">Reason: {draft.reviewReason}</p>
                  )}
                  {draft.reviewedAt && (
                    <p>
                      Reviewed <Stamp value={draft.reviewedAt} />
                    </p>
                  )}
                  {draft.reviewedBy && (
                    <details>
                      <summary>Reviewer identifier</summary>
                      <p>{draft.reviewedBy}</p>
                    </details>
                  )}
                </div>
              )}
            </section>
            <section className="content-card">
              <h2>Generation details</h2>
              {draft.generation?.provider === 'mock' && (
                <p className="review-warning">
                  Local mock provider. These are deterministic source extracts, not a live model
                  response.
                </p>
              )}
              <dl className="metadata-list">
                <dt>Model</dt>
                <dd>{draft.model}</dd>
                <dt>Prompt version</dt>
                <dd>{draft.promptVersion}</dd>
                {draft.generation && (
                  <>
                    <dt>Outcome</dt>
                    <dd>{draft.generation.outcome.replaceAll('_', ' ')}</dd>
                    <dt>Input / output tokens</dt>
                    <dd>
                      {draft.generation.inputTokens} / {draft.generation.outputTokens}
                    </dd>
                    <dt>Estimated variable cost</dt>
                    <dd>
                      ${draft.generation.estimatedCostUsd.toFixed(5)}
                      {draft.generation.usageIncomplete ? ' · Some usage is unknown' : ''}
                    </dd>
                  </>
                )}
              </dl>
            </section>
          </aside>
        </div>
      </div>
    );
  } catch (error) {
    return (
      <div className="page-content">
        <WorkspaceIssue error={error} />
      </div>
    );
  }
}
