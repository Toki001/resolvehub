'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { aiProviderStatusSchema } from '@resolvehub/contracts';
import type { AiProviderStatus as ProviderStatus } from '@resolvehub/contracts';

export function AiProviderStatus({ details = false }: { details?: boolean }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState('Checking AI provider availability.');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/ai/status', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
        });
        if (response.status === 401) {
          if (!cancelled) {
            setStatus(null);
            setError('Sign in to view your AI provider.');
          }
          return;
        }
        if (!response.ok) throw new Error();
        const value = aiProviderStatusSchema.parse(await response.json());
        if (!cancelled) {
          setStatus(value);
          setError('');
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
          setError('AI provider status is unavailable. Your support records are saved.');
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 15000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pathname]);
  const label =
    status?.mode === 'synthetic'
      ? 'Synthetic'
      : status?.mode === 'gemini_live'
        ? 'Gemini Live'
        : 'Unavailable';
  const message = status?.message ?? error;
  if (!details)
    return (
      <Link
        href="/settings#ai"
        className="ai-provider-indicator"
        title={message}
        aria-label={`AI provider: ${label}`}
      >
        <span className={`ai-provider-dot ${status?.mode ?? 'unavailable'}`} />
        {label}
      </Link>
    );
  return (
    <section id="ai" className="content-card" aria-labelledby="ai-provider-heading">
      <h2 id="ai-provider-heading">
        AI provider <span className="status-pill">{label}</span>
      </h2>
      <p role="status">{message}</p>
      {status && (
        <dl className="metadata-list">
          <dt>Generation model</dt>
          <dd>{status.model}</dd>
          <dt>Embedding model</dt>
          <dd>{status.embeddingModel}</dd>
          <dt>Free Tier verification</dt>
          <dd>
            {status.freeTierVerified ? 'Current manual verification' : 'Not verified for cloud use'}
          </dd>
          {status.retryAfterSeconds !== null && (
            <>
              <dt>Retry after</dt>
              <dd>{status.retryAfterSeconds} seconds</dd>
            </>
          )}
        </dl>
      )}
      <p className="muted">
        Cloud requests are limited to verified Free Tier access and approved synthetic workspaces.
        Google may use Free Tier inputs and outputs to improve its products. Infrastructure, hosting
        and storage costs are separate.
      </p>
    </section>
  );
}
