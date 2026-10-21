'use client';
import { useActionState, useEffect, useRef, useState, startTransition } from 'react';
import type { ReactNode, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/lib/actions';
import { JobProgress } from './job-progress';
export function ActionForm({
  action,
  children,
  label,
  reset = true,
  disabled = false,
  className = 'workspace-form',
}: {
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  label: string;
  reset?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const [key, setKey] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => setKey(crypto.randomUUID()), []);
  useEffect(() => {
    if (state.navigateTo) router.push(state.navigateTo);
    if (state.success) {
      if (reset) form.current?.reset();
      setKey(crypto.randomUUID());
      router.refresh();
    }
  }, [state, reset, router]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  }
  return (
    <form
      ref={form}
      action={dispatch}
      onSubmit={submit}
      className={className}
      onChange={() => setKey(crypto.randomUUID())}
    >
      <input type="hidden" name="idempotencyKey" value={key} />
      <fieldset disabled={pending || disabled}>
        {children}
        <button className="primary-button" type="submit" disabled={pending || disabled || !key}>
          {pending ? 'Working…' : label}
        </button>
      </fieldset>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="form-success">
          {state.success}
        </p>
      )}
      {state.jobId && state.jobKind && (
        <JobProgress key={state.jobId} id={state.jobId} kind={state.jobKind} />
      )}
    </form>
  );
}
