// Pure liveness probe for the dashboard. Unlike the `/health` SSR page (which
// calls the MCP server and is really a readiness view), this returns 200 without
// any downstream dependency, so a container HEALTHCHECK reflects "the dashboard
// process is up" rather than "the MCP server is reachable".

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
