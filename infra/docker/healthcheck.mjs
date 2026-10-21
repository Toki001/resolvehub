try {
  const port = process.env.HEALTH_PORT;
  const path = process.env.HEALTH_PATH;
  if (!port || !/^\d{1,5}$/.test(port) || !path?.startsWith('/')) process.exit(1);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(3_000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
