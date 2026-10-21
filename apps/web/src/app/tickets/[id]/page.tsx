import Link from 'next/link';
import { z } from 'zod';
import { WorkspaceTicketDocument } from '@resolvehub/generated';
import { graph } from '@/lib/workspace-api';
import { workspaceTicketSchema } from '@/lib/workspace-schemas';
import {
  PageHeading,
  workspaceAccess,
  AccessPanel,
  WorkspaceIssue,
  StatusPill,
  Stamp,
} from '@/components/workspace-ui';
import { ActionForm } from '@/components/action-form';
import { requestDraft, recordCustomerMessage, changeStatus } from '@/lib/actions';
export const metadata = { title: 'Ticket conversation' };
export default async function Ticket({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await workspaceAccess();
  if (access.kind !== 'connected')
    return (
      <div className="page-content">
        <PageHeading title="Ticket conversation" description="Sign in to read this conversation." />
        <AccessPanel access={access} />
      </div>
    );
  try {
    const id = z.uuid().parse((await params).id);
    const query = await searchParams;
    const { ticket } = await graph(
      WorkspaceTicketDocument,
      { id, messagesAfter: query.after ?? null },
      workspaceTicketSchema,
    );
    if (!ticket)
      return (
        <div className="page-content">
          <h1>Ticket not found</h1>
          <Link href="/tickets">Return to tickets</Link>
        </div>
      );
    const write = access.identity.role !== 'analyst';
    const history = ticket.messageHistory;
    return (
      <div className="page-content">
        <Link className="back-link" href="/tickets">
          ← All tickets
        </Link>
        <PageHeading title={ticket.subject} description={ticket.customerEmail}>
          <StatusPill status={ticket.status} />
        </PageHeading>
        <div className="detail-grid">
          <div>
            <section className="content-card conversation">
              <h2>Conversation history</h2>
              <p className="muted">
                Approved replies are recorded here as internal only. Nothing is sent externally.
              </p>
              {[...history.edges].reverse().map(({ node: m }) => (
                <article
                  key={m.id}
                  className={`message ${m.author === 'agent' ? 'agent-message' : ''}`}
                >
                  <div className="message-heading">
                    <strong>{m.author === 'agent' ? 'Approved reply' : 'Customer message'}</strong>
                    <span>{m.author === 'agent' ? 'Internal only' : 'Received context'}</span>
                  </div>
                  <p className="preserve-text">{m.body}</p>
                  <div className="message-meta">
                    <Stamp value={m.createdAt} />
                    {m.sourceDraftId && (
                      <Link href={`/review/${m.sourceDraftId}`}>View reviewed draft</Link>
                    )}
                  </div>
                </article>
              ))}
              {!history.edges.length && <p>No messages are recorded.</p>}
              <nav className="pagination" aria-label="Conversation history">
                {query.after && (
                  <Link className="secondary-button" href={`/tickets/${id}`}>
                    Latest messages
                  </Link>
                )}
                {history.pageInfo.hasNextPage && history.pageInfo.endCursor && (
                  <Link
                    className="secondary-button"
                    href={`/tickets/${id}?after=${encodeURIComponent(history.pageInfo.endCursor)}`}
                  >
                    Older messages →
                  </Link>
                )}
              </nav>
            </section>
            {write && (
              <section className="content-card">
                <h2>Add customer context</h2>
                <p>
                  Record a follow-up received from the customer. Support replies require draft
                  review and approval.
                </p>
                <ActionForm action={recordCustomerMessage} label="Record customer message">
                  <input type="hidden" name="ticketId" value={id} />
                  <label>
                    Customer message
                    <textarea name="body" required maxLength={20000} rows={4} />
                  </label>
                </ActionForm>
              </section>
            )}
          </div>
          <aside>
            <section className="content-card">
              <h2>Support drafts</h2>
              <p>Draft from published knowledge, then review the evidence and wording.</p>
              {write && (
                <ActionForm action={requestDraft} label="Generate support draft">
                  <input type="hidden" name="ticketId" value={id} />
                </ActionForm>
              )}
              <div className="draft-links">
                {ticket.drafts.map((d) => (
                  <Link className="draft-link" key={d.id} href={`/review/${d.id}`}>
                    <div>
                      <StatusPill status={d.status} />
                      <span>
                        Revision {d.revision}
                        {d.humanEdited ? ' · edited' : ''}
                      </span>
                    </div>
                    <p>
                      {d.text.slice(0, 180)}
                      {d.text.length > 180 ? '…' : ''}
                    </p>
                    <span>Review draft →</span>
                  </Link>
                ))}
                {!ticket.drafts.length && <p className="muted">No drafts yet.</p>}
              </div>
            </section>
            {write && (
              <section className="content-card">
                <h2>Ticket status</h2>
                <ActionForm action={changeStatus} label="Update status">
                  <input type="hidden" name="ticketId" value={id} />
                  <input type="hidden" name="expectedStatus" value={ticket.status} />
                  <label>
                    Action
                    <select
                      name="event"
                      defaultValue={ticket.status === 'resolved' ? 'reopen' : 'wait'}
                    >
                      {ticket.status !== 'resolved' && <option value="wait">Mark pending</option>}
                      <option value="resolve">Resolve</option>
                      <option value="reopen">Reopen</option>
                    </select>
                  </label>
                </ActionForm>
              </section>
            )}
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
