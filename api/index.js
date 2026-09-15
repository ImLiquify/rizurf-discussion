// Vercel entrypoint. All routes are rewritten here (see vercel.json) so the
// existing Express app's own logic — auth, /health, /openapi.json, static
// asset serving from dist/ — runs unchanged, request by request, with no
// persistent process in between invocations.
import app, { ready } from '../server/rizurfApi.js';

// /health and /openapi.json MUST answer fast and independent of everything
// else (RIZURF_API_TEMPLATE.md SS-2/SS-3 — the gateway's own conformance
// checker and health poller time out around 5s). `ready` is the full
// schema-migration check: on a cold Vercel instance that's at least 7
// sequential round trips to the remote MySQL VPS (see
// ensureSchemaCompatibility in server/database.js) before it resolves.
// Gating these two routes behind it risked exactly the failure this
// exists to avoid — a cold health check timing out and the gateway
// dropping the service as unreachable, even though the service itself
// was fine. Neither route needs the migration to have run: /health's own
// databaseIsHealthy() is a plain `SELECT 1`, independent of table shape;
// /openapi.json touches no database at all. Every other route still
// waits for `ready`, since those do need the schema in place.
const FAST_PUBLIC_PATHS = new Set(['/health', '/openapi.json']);

export default async function handler(req, res) {
  const pathname = (req.url || '').split('?')[0];
  if (!FAST_PUBLIC_PATHS.has(pathname)) {
    await ready;
  }
  return app(req, res);
}