import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page-content">
      <div className="empty-state">
        <h1>Page not found</h1>
        <p>This page isn’t part of your workspace.</p>
        <Link href="/tickets" className="text-link">
          Return to Tickets
        </Link>
      </div>
    </div>
  );
}
