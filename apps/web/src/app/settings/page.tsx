import { Check, LockKeyhole, ArrowRight } from 'lucide-react';
import { HealthPanel } from '@/components/health-panel';

export const metadata = { title: 'Settings' };
export default function Settings() {
  return (
    <div className="page-content settings-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">A RELIABLE PLACE TO START</p>
          <h1>Settings</h1>
          <p className="page-description">Your workspace, connections, and what comes next.</p>
        </div>
        <span className="outline-badge">
          <span className="small-dot" />
          Local development
        </span>
      </div>
      <section className="workspace-overview">
        <span className="large-avatar">R</span>
        <div>
          <h2>ResolveHub workspace</h2>
          <p>
            Support platform preview <span>·</span> Version 0.1.0
          </p>
        </div>
        <span className="outline-badge">Development</span>
      </section>
      <HealthPanel />
      <section
        className="settings-panel milestone-panel"
        id="milestone"
        aria-labelledby="milestone-title"
      >
        <div className="list-heading">
          <div>
            <h2 id="milestone-title">Workspace availability</h2>
            <p>Milestone 06 adds cited support drafts with mandatory human review.</p>
          </div>
          <span className="milestone-badge">06 / 08</span>
        </div>
        <div className="milestone-grid">
          <div>
            <h3>Available in this release</h3>
            {[
              'Navigation across all four workspaces',
              'Live service and dependency health',
              'Validated service configuration',
              'Operational background queue probe',
            ].map((text) => (
              <p key={text}>
                <Check size={15} />
                {text}
              </p>
            ))}
          </div>
          <div>
            <h3>Available through authorized integrations</h3>
            <p>
              <ArrowRight size={15} />
              Verified organization membership
            </p>
            <p>
              <ArrowRight size={15} />
              Ticket intake and document indexing
            </p>
            <p>
              <ArrowRight size={15} />
              Cited drafts and explicit abstention
            </p>
            <p>
              <ArrowRight size={15} />
              Audited human approval
            </p>
          </div>
        </div>
        <div className="scope-note">
          <LockKeyhole size={16} />
          <p>
            Dashboard sign-in, customer records, uploads and review are not connected here. Support
            drafts remain pending until an authorized reviewer approves them. Customer messaging is
            not enabled.
          </p>
        </div>
      </section>
    </div>
  );
}
