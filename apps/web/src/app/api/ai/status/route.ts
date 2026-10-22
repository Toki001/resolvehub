import { workspaceClient, apiError, WorkspaceError } from '@/lib/workspace-api';
export async function GET() {
  try {
    const client = await workspaceClient();
    const result = await client.GET('/v1/ai/status', { signal: AbortSignal.timeout(5000) });
    return Response.json(result.error ?? result.data, {
      status: result.response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
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
