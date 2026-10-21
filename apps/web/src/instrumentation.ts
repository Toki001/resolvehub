import { parseWebEnv } from './lib/env';

export async function register() {
  parseWebEnv(process.env);
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeTelemetry } = await import('@resolvehub/telemetry/bootstrap');
    initializeTelemetry('resolvehub-web', false);
  }
}
