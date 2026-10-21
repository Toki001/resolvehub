// Independent of Next.js so CSRF and redirect policy can be tested directly.
export function sameOrigin(origin: string | null, host: string | null) {
  try {
    const url = new URL(origin ?? '');
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && url.host === host;
  } catch {
    return false;
  }
}
export function localDemoAllowed(env: NodeJS.ProcessEnv, host: string | null) {
  return (
    env.NODE_ENV === 'development' &&
    env.DASHBOARD_LOCAL_DEMO === 'true' &&
    !!host &&
    /^(localhost|127\.0\.0\.1):\d+$/.test(host)
  );
}
