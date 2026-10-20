const endpoints = [
  'http://127.0.0.1:3000/api/health',
  'http://127.0.0.1:3001/health/ready',
  'http://127.0.0.1:3002/health/ready',
];
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const ready = await Promise.all(
    endpoints.map(async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
      } catch {
        return false;
      }
    }),
  );
  if (ready.every(Boolean)) {
    console.info('All application services are ready');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.error('Application readiness exceeded 30 seconds');
process.exit(1);
