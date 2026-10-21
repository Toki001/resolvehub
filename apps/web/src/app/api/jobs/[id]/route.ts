import { z } from 'zod';
import { workspaceClient, apiError, WorkspaceError } from '@/lib/workspace-api';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const client = await workspaceClient();
    const result = await client.GET('/v1/jobs/{id}', {
      params: { path: { id: z.uuid().parse(id) } },
      signal: AbortSignal.timeout(5000),
    });
    if (result.error)
      return Response.json(result.error, {
        status: result.response.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    return Response.json(result.data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const fault = error instanceof WorkspaceError ? error : apiError(error);
    return Response.json(
      { code: fault.code, message: fault.message },
      {
        status: fault.code === 'UNAUTHENTICATED' ? 401 : 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
