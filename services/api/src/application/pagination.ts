import { z } from 'zod';
import type { ApiEnv } from '../env.js';
import { fingerprint, seal, unseal } from '../auth/crypto.js';
import { ApiFault } from './fault.js';

const cursorSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    scope: z.string(),
    filterHash: z.string(),
    snapshot: z.iso.datetime({ offset: true }),
    expiresAt: z.number(),
    last: z.object({ id: z.uuid(), createdAt: z.iso.datetime({ offset: true }) }),
  })
  .strict();
type CursorData = z.infer<typeof cursorSchema>;
const argsSchema = z
  .object({
    first: z.number().int().min(1).max(100).default(20),
    after: z.string().min(1).max(2048).optional(),
  })
  .strict();

export class Pagination {
  constructor(private readonly env: Pick<ApiEnv, 'API_SECRET_KEY'>) {}

  window(
    organizationId: string,
    scope: string,
    filter: unknown,
    first?: number | null,
    after?: string | null,
  ) {
    const args = argsSchema.parse({
      ...(first == null ? {} : { first }),
      ...(after == null ? {} : { after }),
    });
    const filterHash = fingerprint(filter);
    let data: CursorData | undefined;
    if (args.after) {
      try {
        data = cursorSchema.parse(
          JSON.parse(unseal(args.after, this.env.API_SECRET_KEY, 'resolvehub:cursor:v1')),
        );
        if (
          data.organizationId !== organizationId ||
          data.scope !== scope ||
          data.filterHash !== filterHash ||
          data.expiresAt < Date.now()
        )
          throw new Error('Invalid cursor scope');
      } catch {
        throw new ApiFault(400, 'INVALID_CURSOR', 'Cursor is invalid or expired.');
      }
    }
    const snapshot = data?.snapshot ?? new Date().toISOString();
    const expiresAt = data?.expiresAt ?? Date.now() + 86_400_000;
    return {
      page: { first: args.first, snapshot, ...(data ? { last: data.last } : {}) },
      connection: <T extends { createdAt: string }>(rows: T[], id: (row: T) => string) => {
        const edges = rows.slice(0, args.first).map((node) => ({
          node,
          cursor: seal(
            JSON.stringify({
              version: 1,
              organizationId,
              scope,
              filterHash,
              snapshot,
              expiresAt,
              last: { id: id(node), createdAt: node.createdAt },
            }),
            this.env.API_SECRET_KEY,
            'resolvehub:cursor:v1',
          ),
        }));
        return {
          edges,
          pageInfo: {
            hasNextPage: rows.length > args.first,
            endCursor: edges.at(-1)?.cursor ?? null,
          },
        };
      },
    };
  }
}
