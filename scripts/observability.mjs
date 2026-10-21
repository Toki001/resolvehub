import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

const composeFile = 'infra/observability.compose.yaml';
const envFile = '.env.observability';
const command = process.argv[2];
function docker(args, env = process.env) {
  execFileSync('docker', args, { env, stdio: 'inherit' });
}
async function setup() {
  try {
    await writeFile(envFile, `GRAFANA_ADMIN_PASSWORD=${randomBytes(32).toString('base64url')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
  }
  await chmod(envFile, 0o600);
  const env = parseEnv(await readFile(envFile, 'utf8'));
  assert.ok(
    (env.GRAFANA_ADMIN_PASSWORD?.length ?? 0) >= 24,
    'Set a private Grafana password of at least 24 characters',
  );
}
if (command === 'up' || command === 'down') {
  await setup();
  docker([
    'compose',
    '--env-file',
    envFile,
    '-f',
    composeFile,
    ...(command === 'up' ? ['up', '-d'] : ['down']),
  ]);
} else if (command === 'check') {
  // A disposable interpolation value is used only for config validation.
  const env = { ...process.env, GRAFANA_ADMIN_PASSWORD: 'configuration-validation-only' };
  docker(['compose', '--env-file', '/dev/null', '-f', composeFile, 'config', '--quiet'], env);
  const compose = parse(await readFile(composeFile, 'utf8'));
  for (const service of Object.values(compose.services))
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/, 'Pin observability images by digest');
  docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '-v',
    `${resolve('infra/otel/collector.yaml')}:/etc/config.yaml:ro`,
    compose.services['otel-collector'].image,
    'validate',
    '--config=/etc/config.yaml',
  ]);
  const prom = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '-v',
    `${resolve('infra/prometheus')}:/etc/prometheus:ro`,
    '-w',
    '/etc/prometheus',
    '--entrypoint',
    '/bin/promtool',
    compose.services.prometheus.image,
  ];
  docker([...prom, 'check', 'config', 'prometheus.yaml']);
  docker([...prom, 'test', 'rules', 'alerts.test.yaml']);
  const dashboard = JSON.parse(await readFile('infra/grafana/dashboards/resolvehub.json', 'utf8'));
  assert.equal(dashboard.uid, 'resolvehub-operations');
  assert.ok(dashboard.panels.length >= 15);
  for (const file of ['datasources', 'dashboards'])
    assert.ok(parse(await readFile(`infra/grafana/provisioning/${file}/resolvehub.yaml`, 'utf8')));
  console.info(
    'Compose, pinned Collector, Prometheus configuration/alert tests and Grafana provisioning validated.',
  );
} else if (command === 'verify') {
  await setup();
  for (const url of [
    'http://127.0.0.1:13133/',
    'http://127.0.0.1:3200/ready',
    'http://127.0.0.1:9090/-/ready',
    'http://127.0.0.1:3003/api/health',
  ])
    assert.ok(
      (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok,
      'Observability service must be ready',
    );
  const env = parseEnv(await readFile(envFile, 'utf8'));
  const headers = {
    Authorization: `Basic ${Buffer.from(`admin:${env.GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`,
  };
  const dashboard = await fetch('http://127.0.0.1:3003/api/dashboards/uid/resolvehub-operations', {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(dashboard.ok, 'Grafana must serve the provisioned dashboard');
  const sources = await fetch('http://127.0.0.1:3003/api/datasources', {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(sources.ok, 'Grafana datasource API must be authenticated');
  const datasources = await sources.json();
  for (const uid of ['resolvehub-prometheus', 'resolvehub-tempo'])
    assert.ok(datasources.some((source) => source.uid === uid));
  console.info(
    'Four local services ready; authenticated Grafana dashboard and both datasources provisioned.',
  );
} else {
  throw new Error('Use observability.mjs up, down, check or verify');
}
