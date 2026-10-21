import Link from 'next/link';
import { release } from '@/lib/release';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  CircleCheck,
  Inbox,
  LockKeyhole,
  MessageSquareText,
  Sparkles,
} from 'lucide-react';

const sections = {
  tickets: {
    eyebrow: 'EVERY CONVERSATION, IN CONTEXT',
    title: 'Tickets',
    description: 'A calmer place to take care of your customers.',
    listTitle: 'All tickets',
    listDescription: 'Your team’s conversations will live here.',
    emptyTitle: 'Ready for your first conversation',
    emptyText:
      'Ticket intake is available through authorized integrations. Dashboard sign-in and conversation access are not connected yet.',
    icon: Inbox,
    columns: ['Conversation', 'Customer', 'Status', 'Updated'],
    next: 'Dashboard sign-in and ticket access',
  },
  knowledge: {
    eyebrow: 'ANSWERS START WITH GOOD SOURCES',
    title: 'Knowledge Base',
    description: 'A shared source of truth for more helpful answers.',
    listTitle: 'Knowledge documents',
    listDescription: 'Verified knowledge, ready for your team.',
    emptyTitle: 'Make room for what your team knows',
    emptyText:
      'Document indexing is available through authorized integrations. Dashboard uploads and knowledge access are not connected yet.',
    icon: BookOpen,
    columns: ['Document', 'Source', 'Status', 'Updated'],
    next: 'Dashboard uploads and knowledge access',
  },
  review: {
    eyebrow: 'YOUR TEAM HAS THE FINAL SAY',
    title: 'Review Queue',
    description: 'Helpful AI drafts. Thoughtful human decisions.',
    listTitle: 'Drafts awaiting review',
    listDescription: 'Every response deserves a human perspective.',
    emptyTitle: 'A space for a second look',
    emptyText:
      'Cited support drafts and human approval are available through authorized integrations. Dashboard review access is not connected yet.',
    icon: CheckCheck,
    columns: ['Draft', 'Ticket', 'Evidence', 'Created'],
    next: 'Dashboard draft review and approval',
  },
};

export function WorkspacePage({ section }: { section: keyof typeof sections }) {
  const content = sections[section];
  const Icon = content.icon;
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className="page-description">{content.description}</p>
        </div>
        <span className="outline-badge">
          <span className="small-dot" />
          Workspace foundation
        </span>
      </div>
      <div className="foundation-banner">
        <span className="banner-icon">
          <Sparkles size={19} />
        </span>
        <div>
          <strong>Your workspace is taking shape</strong>
          <p>
            Support workflows are available through authorized integrations. Dashboard access is not
            connected yet.
          </p>
        </div>
        <Link href="/settings#milestone">
          See what’s connected <ArrowRight size={16} />
        </Link>
      </div>
      <section className="list-panel" aria-labelledby="list-title">
        <div className="list-heading">
          <div>
            <h2 id="list-title">{content.listTitle}</h2>
            <p>{content.listDescription}</p>
          </div>
          <span className="subtle-label">Dashboard access unavailable</span>
        </div>
        <div className="table-heading" aria-hidden="true">
          {content.columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
        <div className="empty-state">
          <div className="empty-art" aria-hidden="true">
            <span className="orbit orbit-one" />
            <span className="orbit orbit-two" />
            <span className="empty-icon">
              <Icon size={30} strokeWidth={1.5} />
            </span>
            <span className="art-spark">
              <Sparkles size={13} />
            </span>
          </div>
          <h3>{content.emptyTitle}</h3>
          <p>{content.emptyText}</p>
          <Link href="/settings#milestone" className="text-link">
            Explore the foundation <ArrowRight size={15} />
          </Link>
        </div>
        <div className="list-footer">
          <span>
            <LockKeyhole size={13} />
            Dashboard records are not connected.
          </span>
          <span>Milestone {release.milestone}</span>
        </div>
      </section>
      <div className="info-grid">
        <section className="info-card">
          <span className="info-icon">
            <MessageSquareText size={20} />
          </span>
          <div>
            <h3>Context makes better support</h3>
            <p>Tickets, trusted knowledge, and reviewed replies — together in one workspace.</p>
            <Link href="/knowledge">
              Explore Knowledge Base <ArrowUpRight size={14} />
            </Link>
          </div>
        </section>
        <section className="info-card">
          <span className="info-icon warm">
            <CircleCheck size={20} />
          </span>
          <div>
            <h3>People stay in control</h3>
            <p>AI assistance is designed around verifiable sources and human approval.</p>
            <Link href="/review">
              Explore Review Queue <ArrowUpRight size={14} />
            </Link>
          </div>
        </section>
      </div>
      <div className="next-step">
        <span className="step-number" aria-hidden="true">
          <LockKeyhole size={15} />
        </span>
        <div>
          <span>DASHBOARD CONNECTION STILL NEEDED</span>
          <strong>{content.next}</strong>
        </div>
        <Link href="/settings#milestone" aria-label="View milestone details">
          <ArrowUpRight size={19} />
        </Link>
      </div>
    </div>
  );
}
