'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  CircleHelp,
  Inbox,
  Layers2,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { release } from '@/lib/release';

const navigation = [
  { href: '/tickets', label: 'Tickets', icon: Inbox },
  { href: '/knowledge', label: 'Knowledge Base', icon: BookOpen },
  { href: '/review', label: 'Review Queue', icon: CheckCheck },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current =
    [...navigation, { href: '/settings', label: 'Settings' }].find((item) =>
      pathname.startsWith(item.href),
    )?.label ?? 'Workspace';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <Link href="/tickets" className="brand" aria-label="ResolveHub home">
          <span className="brand-mark">
            <Layers2 size={21} strokeWidth={2.2} />
          </span>
          ResolveHub<span className="brand-period">.</span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-avatar">R</span>
          <div>
            <strong>ResolveHub</strong>
            <span>Development workspace</span>
          </div>
          <span className="local-dot" title="Local environment" />
        </div>
        <p className="nav-heading">WORKSPACE</p>
        <nav aria-label="Main">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-item ${pathname.startsWith(href) ? 'active' : ''}`}
              aria-current={pathname.startsWith(href) ? 'page' : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="nav-divider" />
        <Link
          href="/settings"
          aria-label="Settings"
          className={`nav-item ${pathname === '/settings' ? 'active' : ''}`}
          aria-current={pathname === '/settings' ? 'page' : undefined}
        >
          <Settings2 size={18} />
          <span>Settings</span>
        </Link>
        <div className="sidebar-bottom">
          <div className="foundation-note">
            <span className="note-icon">
              <ShieldCheck size={19} />
            </span>
            <strong>A thoughtful foundation.</strong>
            <p>
              Built for reliable support.
              <br />
              Human judgment at the center.
            </p>
            <Link href="/settings#milestone">
              View workspace status <ArrowUpRight size={14} />
            </Link>
          </div>
          <div className="sidebar-footer">
            <span className="environment-dot" />
            Local development<span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{current}</strong>
          </div>
          <div className="topbar-right">
            <span className="milestone-badge">Milestone {release.milestone}</span>
            <Link href="/settings#health" className="help-link" aria-label="View system health">
              <CircleHelp size={18} />
            </Link>
            <span className="profile-avatar" title="Local dashboard; sign-in is not connected">
              RH
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1">
          {children}
        </main>
        <footer className="page-footer">
          <span>Better support starts with clarity.</span>
          <span>
            Local workspace <span aria-hidden="true">·</span> Foundation release
          </span>
        </footer>
      </div>
    </div>
  );
}
