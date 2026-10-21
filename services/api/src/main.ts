import { initializeTelemetry } from '@resolvehub/telemetry/bootstrap';

// Dynamic import guarantees SDK and ESM hooks precede all application modules.
initializeTelemetry('resolvehub-api');
await import('./application.js');
