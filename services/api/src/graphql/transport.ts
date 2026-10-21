import {
  context as otelContext,
  count,
  observe,
  tracer,
  trace,
  SpanStatusCode,
} from '@resolvehub/telemetry';
import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError, GraphQLScalarType, Kind, valueFromASTUntyped } from 'graphql';
import type { DocumentNode, SelectionSetNode } from 'graphql';
import { z } from 'zod';
import type { GraphqlContext } from '../auth/context.js';

function scalar(name: string, validate: (value: unknown) => string) {
  return new GraphQLScalarType({
    name,
    serialize: validate,
    parseValue: validate,
    parseLiteral: (node) => {
      if (node.kind !== Kind.STRING)
        throw new GraphQLError('Value must be a string.', {
          extensions: { code: 'INVALID_INPUT' },
        });
      return validate(node.value);
    },
  });
}
export const scalarResolvers = {
  Cursor: scalar('Cursor', (value) => z.string().min(1).max(2048).parse(value)),
  DateTime: scalar('DateTime', (value) => z.iso.datetime({ offset: true }).parse(value)),
};

// Evaluate real variable values after GraphQL validation. Nested list factors
// account for their server-enforced limits and fragments count toward the budget.
export function checkQueryBudget(
  document: DocumentNode,
  selection: SelectionSetNode,
  variables: Record<string, unknown>,
  maxCost = 2_000,
): void {
  const operation = document.definitions.find(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION && definition.selectionSet === selection,
  );
  const defaults =
    operation?.kind === Kind.OPERATION_DEFINITION
      ? Object.fromEntries(
          (operation.variableDefinitions ?? [])
            .filter((definition) => definition.defaultValue)
            .map((definition) => [
              definition.variable.name.value,
              definition.defaultValue ? valueFromASTUntyped(definition.defaultValue) : undefined,
            ]),
        )
      : {};
  const effectiveVariables = { ...defaults, ...variables };
  let cost = 0;
  const visit = (set: SelectionSetNode, factor: number, depth: number) => {
    if (depth > 12)
      throw new GraphQLError('Query depth exceeds the limit.', {
        extensions: { code: 'INVALID_INPUT', http: { status: 400 } },
      });
    for (const node of set.selections) {
      cost += factor;
      if (cost > maxCost)
        throw new GraphQLError('Query cost exceeds the limit.', {
          extensions: { code: 'INVALID_INPUT', http: { status: 400 } },
        });
      if (node.kind === Kind.FIELD) {
        let quantity = 1;
        if (['tickets', 'knowledgeDocuments', 'knowledgeSearch'].includes(node.name.value)) {
          const arg = node.arguments?.find((entry) => entry.name.value === 'first');
          quantity = z
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(arg ? (valueFromASTUntyped(arg.value, effectiveVariables) ?? 20) : 20);
        } else if (['messages', 'drafts'].includes(node.name.value)) quantity = 100;
        if (node.selectionSet) visit(node.selectionSet, factor * quantity, depth + 1);
      } else if (node.kind === Kind.INLINE_FRAGMENT) visit(node.selectionSet, factor, depth + 1);
      else {
        const fragment = document.definitions.find(
          (entry) =>
            entry.kind === Kind.FRAGMENT_DEFINITION && entry.name.value === node.name.value,
        );
        if (fragment?.kind === Kind.FRAGMENT_DEFINITION)
          visit(fragment.selectionSet, factor, depth + 1);
      }
    }
  };
  visit(selection, 1, 0);
}

const known = new Set([
  'INVALID_INPUT',
  'INVALID_CURSOR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_CONTENT',
  'CAPACITY_EXCEEDED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export const contractPlugin: ApolloServerPlugin<GraphqlContext> = {
  async requestDidStart(request) {
    const started = performance.now();
    const span = tracer.startSpan('graphql.request', {
      attributes: { operation: 'graphql.request' },
    });
    request.contextValue.telemetryContext = trace.setSpan(otelContext.active(), span);
    return {
      async didResolveOperation(context) {
        if (context.operation && context.document) {
          try {
            checkQueryBudget(
              context.document,
              context.operation.selectionSet,
              context.request.variables ?? {},
            );
          } catch (error) {
            if (error instanceof GraphQLError) throw error;
            throw new GraphQLError('Pagination input is invalid.', {
              extensions: { code: 'INVALID_INPUT', http: { status: 400 } },
            });
          }
        }
      },
      async willSendResponse(context) {
        const failed = Boolean(context.errors?.length);
        count('graphql_requests', 1, { outcome: failed ? 'error' : 'success' });
        observe('graphql_request_duration_seconds', (performance.now() - started) / 1000);
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        const requestId = context.contextValue.req.requestId;
        if (context.response.body.kind !== 'single') return;
        const result = context.response.body.singleResult;
        result.extensions = { requestId };
        if (result.errors)
          result.errors = result.errors.map((error) => {
            const originalCode =
              typeof error.extensions?.code === 'string' ? error.extensions.code : '';
            const code = known.has(originalCode)
              ? originalCode
              : ['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT'].includes(
                    originalCode,
                  )
                ? 'INVALID_INPUT'
                : 'INTERNAL_ERROR';
            const extensions = error.extensions ?? {};
            return {
              message:
                code === 'INTERNAL_ERROR' ? 'Request could not be completed.' : error.message,
              ...(error.path ? { path: error.path } : {}),
              extensions: {
                code,
                message:
                  code === 'INTERNAL_ERROR' ? 'Request could not be completed.' : error.message,
                requestId,
                httpStatus:
                  typeof extensions.httpStatus === 'number'
                    ? extensions.httpStatus
                    : code === 'INVALID_INPUT'
                      ? 400
                      : 500,
                ...(extensions.details ? { details: extensions.details } : {}),
              },
            };
          });
      },
    };
  },
};
