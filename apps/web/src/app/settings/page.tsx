import Link from 'next/link';
import { Check, ShieldCheck } from 'lucide-react';
import { HealthPanel } from '@/components/health-panel';
import { release } from '@/lib/release';
import { PageHeading, workspaceAccess, WorkspaceIssue } from '@/components/workspace-ui';
import { ActionForm } from '@/components/action-form';
import { signOut } from '@/lib/actions';
import { BackgroundJobs } from '@/components/background-jobs';
import { AiProviderStatus } from '@/components/ai-provider-status';
export const metadata = { title: 'Settings' };
export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await workspaceAccess();
  const params = await searchParams;
  return (
    <div className="page-content settings-content">
      <PageHeading
        title="Settings"
        description="Workspace access, service health and processing history."
      />
      <section className="content-card" id="account">
        <h2>Workspace access</h2>
        {access.kind === 'connected' ? (
          <>
            <p className="connected-account">
              <ShieldCheck size={18} /> Signed in as <strong>{access.identity.subject}</strong>
            </p>
            <dl className="metadata-list">
              <dt>Membership</dt>
              <dd>{access.identity.role}</dd>
              <dt>Organization</dt>
              <dd>{access.identity.organizationId}</dd>
            </dl>
            <ActionForm action={signOut} label="Sign out" />
          </>
        ) : access.kind === 'unavailable' ? (
          <WorkspaceIssue error={access.error} />
        ) : (
          <>
            <p>Connect your organization to access tickets, uploads, drafting and human review.</p>
            <Link className="primary-button" href="/sign-in">
              Sign in
            </Link>
          </>
        )}
      </section>
      <HealthPanel />
      <AiProviderStatus details />
      {access.kind === 'connected' && (
        <BackgroundJobs
          admin={access.identity.role === 'admin'}
          {...(params.after ? { after: params.after } : {})}
        />
      )}
      <section
        className="settings-panel milestone-panel"
        id="milestone"
        aria-labelledby="milestone-title"
      >
        <div className="list-heading">
          <div>
            <h2 id="milestone-title">Workspace availability</h2>
            <p>
              The dashboard is connected to the authenticated support APIs. Sign in to use your
              organization’s records.
            </p>
          </div>
          <span className="milestone-badge">
            {release.milestone} / {release.totalMilestones}
          </span>
        </div>
        <div className="milestone-grid">
          <div>
            <h3>Available in this workspace</h3>
            {[
              'Verified organization membership and session sign-in',
              'Ticket creation, customer context and conversation history',
              'Private document uploads and versioned indexing',
              'Cited drafting, editing, approval and rejection',
              'Internal approved replies with delivery status',
              'Background job status and authorized dead-letter replay',
            ].map((text) => (
              <p key={text}>
                <Check size={15} />
                {text}
              </p>
            ))}
          </div>
          <div>
            <h3>Operations and delivery</h3>
            {[
              'Live service and dependency health',
              'Locally verified CI/CD and production images',
              'OpenTelemetry and local operations dashboards',
              'Human approval before a reply is recorded',
              'No external customer delivery configured',
            ].map((text) => (
              <p key={text}>
                <Check size={15} />
                {text}
              </p>
            ))}
          </div>
        </div>
        <div className="scope-note">
          <ShieldCheck size={16} />
          <p>
            Approved replies are saved inside the ticket conversation with internal delivery status.
            SMTP email and outbound webhooks are not implemented or configured. Draft generation
            uses the configured provider; local mock outputs are clearly labeled.
          </p>
        </div>
      </section>
    </div>
  );
}
