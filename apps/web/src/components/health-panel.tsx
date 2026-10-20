'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  RefreshCw,
  Server,
  Database,
  HardDrive,
  Workflow,
  Radio,
} from 'lucide-react';
import { z } from 'zod';

const statusSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checkedAt: z.iso.datetime(),
  checks: z.object({
    api: z.enum(['up', 'down', 'unknown']),
    worker: z.enum(['up', 'down', 'unknown']),
    postgres: z.enum(['up', 'down', 'unknown']),
    redis: z.enum(['up', 'down', 'unknown']),
    storage: z.enum(['up', 'down', 'unknown']),
  }),
});
type Status = z.infer<typeof statusSchema>;
const services = [
  { key: 'api', name: 'API', description: 'Workspace service', icon: Server },
  {
    key: 'worker',
    name: 'Background worker',
    description: 'Asynchronous processing',
    icon: Workflow,
  },
  {
    key: 'postgres',
    name: 'Database',
    description: 'PostgreSQL with vector support',
    icon: Database,
  },
  { key: 'redis', name: 'Queue connection', description: 'Redis', icon: Radio },
  { key: 'storage', name: 'Object storage', description: 'MinIO', icon: HardDrive },
] as const;

export function HealthPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch('/api/status', {
        cache: 'no-store',
        signal: signal ?? AbortSignal.timeout(6_000),
      });
      if (!response.ok) throw new Error('Health check unavailable');
      const result = statusSchema.parse(await response.json());
      if (!signal?.aborted) setStatus(result);
    } catch {
      if (!signal?.aborted) {
        setStatus(null);
        setFailed(true);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <section className="settings-panel" id="health" aria-labelledby="health-title">
      <div className="list-heading">
        <div>
          <h2 id="health-title">
            <Activity size={18} />
            System health
          </h2>
          <p>Live connectivity checks for your local workspace.</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
      <div className="health-summary" role="status" aria-live="polite">
        <span
          className={`status-dot ${loading ? '' : status?.status === 'ready' ? 'healthy' : 'unavailable'}`}
        />
        <strong>
          {loading
            ? 'Checking connections…'
            : failed
              ? 'Health check could not be completed'
              : status?.status === 'ready'
                ? 'All systems connected'
                : 'Some connections need attention'}
        </strong>
        {status && !loading && (
          <span>
            Checked{' '}
            {new Date(status.checkedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
      {failed && (
        <p className="health-error">
          The workspace could not reach the health service. Check that the local services are
          running, then refresh.
        </p>
      )}
      <div className="health-list">
        {services.map(({ key, name, description, icon: Icon }) => {
          const state = loading ? 'checking' : (status?.checks[key] ?? 'unknown');
          return (
            <div className="health-row" key={key}>
              <span className="health-icon">
                <Icon size={19} />
              </span>
              <div>
                <strong>{name}</strong>
                <p>{description}</p>
              </div>
              <span className={`connection-badge ${state}`}>
                {state === 'up' && <Check size={12} />}
                {state === 'up'
                  ? 'Connected'
                  : state === 'down'
                    ? 'Unavailable'
                    : state === 'checking'
                      ? 'Checking'
                      : 'Unknown'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
