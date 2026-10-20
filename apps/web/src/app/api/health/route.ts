export function GET() {
  return Response.json(
    { status: 'alive', service: 'web' },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
