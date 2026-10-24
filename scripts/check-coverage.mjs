import { readFileSync } from 'node:fs';

// Jest subtracts directory-specific threshold groups from its global group.
// Check the actual total as well, retaining the independent critical-area gates.
const report = JSON.parse(
  readFileSync(process.argv[2] ?? 'coverage/coverage-summary.json', 'utf8'),
);
const branches = report?.total?.branches;
if (
  !Number.isSafeInteger(branches?.total) ||
  !Number.isSafeInteger(branches?.covered) ||
  branches.total <= 0 ||
  branches.covered < 0 ||
  branches.covered > branches.total
)
  throw new Error('Coverage report is missing valid overall branch counts.');
const actual = (branches.covered / branches.total) * 100;
if (actual < 95) throw new Error(`Overall branch coverage ${actual.toFixed(2)}% is below 95%.`);
console.info(
  `Overall branch coverage: ${branches.covered}/${branches.total} (${actual.toFixed(2)}%); 95% gate passed.`,
);
