import Link from 'next/link';
import { z } from 'zod';
import { TicketsDocument, DashboardSummaryDocument } from '@resolvehub/generated';
import { graph } from '@/lib/workspace-api';
import { ticketsSchema, summarySchema } from '@/lib/workspace-schemas';
import { ActionForm } from '@/components/action-form';
import { createTicket } from '@/lib/actions';
import {
  PageHeading,
  workspaceAccess,
  AccessPanel,
  WorkspaceIssue,
  StatusPill,
  Pager,
  Stamp,
} from '@/components/workspace-ui';
export const metadata = { title: 'Tickets' };
export default async function Tickets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await workspaceAccess();
  const heading = (
    <PageHeading
      title="Tickets"
      description="Customer conversations, grounded drafts and thoughtful replies."
    />
  );
  if (access.kind !== 'connected')
    return (
      <div className="page-content">
        {heading}
        <AccessPanel access={access} />
      </div>
    );
  try {
    const params = await searchParams;
    const filter = {
      ...(params.query ? { query: z.string().max(200).parse(params.query) } : {}),
      ...(params.status
        ? { status: z.enum(['open', 'pending', 'resolved']).parse(params.status) }
        : {}),
    };
    const [data, summary] = await Promise.all([
      graph(TicketsDocument, { first: 20, after: params.after ?? null, filter }, ticketsSchema),
      graph(DashboardSummaryDocument, {}, summarySchema),
    ]);
    const stats = summary.dashboardSummary;
    return (
      <div className="page-content">
        <PageHeading
          title="Tickets"
          description="Customer conversations, grounded drafts and thoughtful replies."
        >
          {access.identity.role !== 'analyst' && (
            <a className="primary-button" href="#new-ticket">
              New ticket
            </a>
          )}
        </PageHeading>
        <div className="summary-grid">
          {[
            ['Open tickets', stats.openTickets],
            ['Pending tickets', stats.pendingTickets],
            ['Published documents', stats.publishedDocuments],
            ['Awaiting review', stats.pendingReviews],
          ].map(([label, count]) => (
            <div className="summary-card" key={label}>
              <span>{label}</span>
              <strong>{count}</strong>
            </div>
          ))}
        </div>
        <section className="list-panel">
          <div className="list-heading">
            <div>
              <h2>All tickets</h2>
              <p>Only conversations in your verified organization appear here.</p>
            </div>
            <span className="subtle-label">
              {access.identity.role === 'analyst' ? 'Read-only access' : 'Connected workspace'}
            </span>
          </div>
          <form className="filter-form" method="get">
            <label>
              Search tickets
              <input
                name="query"
                defaultValue={params.query}
                maxLength={200}
                placeholder="Search by subject"
              />
            </label>
            <label>
              Status
              <select name="status" defaultValue={params.status ?? ''}>
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="resolved">Resolved</option>
              </select>
            </label>
            <button className="secondary-button">Apply filters</button>
          </form>
          {data.tickets.edges.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Conversation</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="optional-column">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tickets.edges.map(({ node: t }) => (
                    <tr key={t.id}>
                      <td>
                        <Link href={`/tickets/${t.id}`}>{t.subject}</Link>
                      </td>
                      <td>{t.customerEmail}</td>
                      <td>
                        <StatusPill status={t.status} />
                      </td>
                      <td className="optional-column">
                        <Stamp value={t.updatedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="record-empty">
              <h3>{params.query || params.status ? 'No matching tickets' : 'No tickets yet'}</h3>
              <p>
                {params.query || params.status
                  ? 'Try another search or status.'
                  : 'Create a ticket to start a real conversation in this workspace.'}
              </p>
            </div>
          )}
          <Pager
            base="/tickets"
            info={data.tickets.pageInfo}
            values={{
              ...(params.query ? { query: params.query } : {}),
              ...(params.status ? { status: params.status } : {}),
            }}
          />
        </section>
        {access.identity.role !== 'analyst' && (
          <section className="content-card" id="new-ticket">
            <h2>Create a ticket</h2>
            <p>
              Record the customer’s question. Future responses remain internal unless a delivery
              integration is added.
            </p>
            <ActionForm action={createTicket} label="Create ticket">
              <div className="form-grid">
                <label>
                  Subject
                  <input name="subject" required maxLength={200} />
                </label>
                <label>
                  Customer email
                  <input name="customerEmail" type="email" required maxLength={254} />
                </label>
              </div>
              <label>
                Customer message
                <textarea name="message" required maxLength={20000} rows={5} />
              </label>
            </ActionForm>
          </section>
        )}
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
