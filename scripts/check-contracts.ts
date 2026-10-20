import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildSchema, parse, validate } from 'graphql';
import { parse as parseYaml } from 'yaml';
import ts from 'typescript';
import { z } from 'zod';

const root = process.cwd();
const document = z
  .object({
    openapi: z.literal('3.1.0'),
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .parse(parseYaml(await readFile(path.join(root, 'packages/contracts/openapi.yaml'), 'utf8')));
await SwaggerParser.validate(path.join(root, 'packages/contracts/openapi.yaml'));
const schema = buildSchema(
  await readFile(path.join(root, 'packages/contracts/schema.graphql'), 'utf8'),
);
for (const file of await readdir(path.join(root, 'packages/contracts/operations'))) {
  if (!file.endsWith('.graphql')) continue;
  const errors = validate(
    schema,
    parse(await readFile(path.join(root, 'packages/contracts/operations', file), 'utf8')),
  );
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    `Invalid GraphQL operations in ${file}`,
  );
}

function decorator(node: ts.Node, name: string): string | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  for (const entry of ts.getDecorators(node) ?? []) {
    if (
      !ts.isCallExpression(entry.expression) ||
      !ts.isIdentifier(entry.expression.expression) ||
      entry.expression.expression.text !== name
    )
      continue;
    const argument = entry.expression.arguments[0];
    if (!argument) return '';
    assert(ts.isStringLiteral(argument), `${name} paths must be explicit string literals`);
    return argument.text;
  }
  return undefined;
}
const actual = new Set<string>();
async function findControllers(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? findControllers(filename)
        : Promise.resolve(entry.name.endsWith('.controller.ts') ? [filename] : []);
    }),
  );
  return files.flat().sort();
}
const controllerFiles = await findControllers('services/api/src');
for (const filename of controllerFiles) {
  const source = ts.createSourceFile(
    filename,
    await readFile(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    const prefix = decorator(node, 'Controller');
    if (prefix === undefined) return;
    for (const member of node.members) {
      for (const method of ['Get', 'Post', 'Put', 'Patch', 'Delete']) {
        const suffix = decorator(member, method);
        if (suffix === undefined) continue;
        const url = `/${[prefix, suffix].filter(Boolean).join('/')}`.replace(
          /:([A-Za-z]+)/g,
          '{$1}',
        );
        actual.add(`${method.toUpperCase()} ${url}`);
      }
    }
  });
}
const declared = new Set<string>();
for (const [url, item] of Object.entries(document.paths)) {
  for (const method of Object.keys(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method))
      declared.add(`${method.toUpperCase()} ${url}`);
  }
}
assert.deepEqual(
  [...actual].sort(),
  [...declared].sort(),
  'REST controllers and canonical OpenAPI routes drifted',
);
console.info(
  `OpenAPI 3.1 valid; ${declared.size} REST operations match controllers; GraphQL SDL and all client operations validate.`,
);
