import { cp } from 'node:fs/promises';

// Next standalone output intentionally omits static assets. Docker copies these
// into its web target; local compiled startup needs the same packaging step.
const web = new URL('../apps/web/', import.meta.url);
await cp(new URL('.next/static/', web), new URL('.next/standalone/apps/web/.next/static/', web), {
  recursive: true,
});
// Local development commands remain loopback-only; containers bind explicitly.
process.env.HOSTNAME = '127.0.0.1';
await import(new URL('.next/standalone/apps/web/server.js', web).href);
