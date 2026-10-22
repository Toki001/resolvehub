'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import Link from 'next/link';
import { aiFailureMessage } from '@resolvehub/contracts';
const jobSchema = z.object({
  status: z.enum(['accepted', 'processing', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number(),
  reasonCode: z.string().nullable(),
  resourceId: z.string().nullable(),
});
export function JobProgress({
  id,
  kind,
}: {
  id: string;
  kind: 'draft_response' | 'document_ingestion';
}) {
  const [state, setState] = useState<{
    status: string;
    attempts: number;
    reasonCode?: string | null;
    resourceId?: string | null;
  }>({ status: 'accepted', attempts: 0 });
  const [error, setError] = useState('');
  const [cycle, setCycle] = useState(0);
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${id}`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
        });
        if (!response.ok) throw new Error();
        const job = jobSchema.parse(await response.json());
        if (cancelled) return;
        setError('');
        setState(job);
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
          router.refresh();
          return;
        }
        if (++polls >= 120) {
          setError('This job is still running. You can check again without resubmitting it.');
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!cancelled)
          setError('Job status is unavailable. Your accepted job has not been resubmitted.');
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, cycle, router]);
  return (
    <div className="job-progress" aria-live="polite">
      <strong>Background job: {state.status}</strong>
      <span>Attempt {state.attempts} of 4</span>
      {state.reasonCode && (
        <p>
          {state.reasonCode.startsWith('GEMINI_')
            ? aiFailureMessage(state.reasonCode)
            : state.reasonCode}
        </p>
      )}
      {state.status === 'succeeded' && kind === 'draft_response' && state.resourceId && (
        <Link className="text-link" href={`/review/${state.resourceId}`}>
          Review draft →
        </Link>
      )}
      {state.status === 'succeeded' && kind === 'document_ingestion' && (
        <p>Index published. This document is available for retrieval.</p>
      )}
      {state.status === 'failed' && (
        <Link className="text-link" href="/settings#jobs">
          Inspect failure and replay options →
        </Link>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button type="button" className="secondary-button" onClick={() => setCycle((c) => c + 1)}>
            Check job again
          </button>
        </>
      )}
    </div>
  );
}
