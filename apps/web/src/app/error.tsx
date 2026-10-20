'use client';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="page-content">
      <div className="empty-state">
        <h1>Something didn’t load</h1>
        <p>The workspace could not load this page. Please try again.</p>
        <button type="button" className="secondary-button" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
