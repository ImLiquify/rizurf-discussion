# Making a Rizurf microapp fast and reliable

For the team, or the coding agent, working on **one microapp** connected to
the Rizurf API Gateway. Work through it top to bottom: the sections are in
order of how much time they save. Each one says what to check, what to
change, and how to confirm it worked.

This document adds to two others and never overrides them:

- **`RIZURF_API_TEMPLATE.md`**: the service contract (`/health`,
  `/openapi.json`, error shape).
- **`MICROAPP_AUTH.md`**: sign-in through the gateway. In particular, **§5
  (check the gateway on every request, no cache) still applies.** Nothing
  below caches a session check. Section 5 here makes that check cheaper
  without skipping it.

---

## 0. Why this matters: what the gateway measured

The gateway polls every connected app's `/health` and `/openapi.json` to
build its catalog. On 2026-09-24 it timed each one from outside:

| Service | `/health` | `/openapi.json` |
|---|---|---|
| hr-recruitment-demo.vercel.app | **1665 ms** | 326 ms |
| intern-database.vercel.app | **1108 ms** | 333 ms |
| rizurf-realty-interns-six.vercel.app | **957 ms** | 110 ms |
| employee-personal-version.vercel.app | 685 ms | 344 ms |
| department-zeta.vercel.app | 652 ms | 332 ms |
| rizurf-feedback.vercel.app | 650 ms | 324 ms |
| rizurf-fleet.vercel.app | 443 ms | 330 ms |
| central.rizurf.com | 247 ms | 54 ms |
| relationship.rizurf.com | 227 ms | 62 ms |
| esign.crevascale.com | 138 ms | 61 ms |
| rizurf-attendance-app.vercel.app | **403 Forbidden** | **403 Forbidden** |

Target: **`/health` under 300 ms, `/openapi.json` under 150 ms, a typical
signed-in page under 500 ms.** The contract's hard limit is 1 second, and
three services are at or over it.

The gateway had the same problems and fixed them. Its pages went from about
2 s to about 0.15 s with sections 1, 2, 4 and 6 below. The biggest single
fix was section 1.

---

## 1. Run your code in the same region as your database (biggest win)

**The problem.** On Vercel, serverless functions default to **Washington
D.C. (`iad1`)**. If your database is anywhere else (Singapore, Tokyo, Kuala
Lumpur, a Supabase project in `ap-southeast-1`), **every query crosses an
ocean**, at 150–300 ms each. A page that runs 6 queries one after another
spends 1–2 seconds just waiting on the network. No code optimisation can
beat that; only moving the code can.

The gateway itself now runs in **Singapore (`sin1`)**, and its database is in
Kuala Lumpur. Every app also calls the gateway on each signed-in request
(`/oauth/introspect`, MICROAPP_AUTH.md §5), so an app in Southeast Asia is
closest to both.

**Check where your functions run.** Every Vercel response carries a header
of the form `edge::function::id`:

```bash
curl -sI https://YOUR-APP.vercel.app/health | grep -i x-vercel-id
# x-vercel-id: sin1::iad1::abc123   <- edge in Singapore, FUNCTION in Washington
```

The **second** part is where your code runs.

**Find where your database is.** Supabase: Project Settings → General →
Region. Neon, PlanetScale, Railway, Hostinger: see the dashboard or the
hostname. Pick the Vercel region nearest to it:

| Database region | Vercel region |
|---|---|
| Singapore / Kuala Lumpur / ap-southeast-1 | `sin1` |
| Tokyo / ap-northeast-1 | `hnd1` |
| Sydney / ap-southeast-2 | `syd1` |
| Mumbai / ap-south-1 | `bom1` |
| US East / us-east-1 | `iad1` (the default) |
| Frankfurt / eu-central-1 | `fra1` |

**Fix.** Add a `vercel.json` with the region:

```json
{
  "regions": ["sin1"]
}
```

⚠️ **Put it where you run `vercel deploy` from.** If the Vercel project has a
*Root Directory* set (e.g. the app lives in `web/`) and you deploy with the
CLI from the repo root, the CLI reads `vercel.json` from the **repo root**,
not the subfolder. The gateway lost a deploy to exactly this. Confirm with
`vercel inspect <deployment-url>`: every function should list the new
region, not `[iad1]`. Then re-run the `curl` above.

If you use Next.js, you can instead set it per route with
`export const preferredRegion = "sin1"`.

---

## 2. Stop waiting for things one at a time

**The problem.** This pattern is everywhere and costs one full database
round trip per line:

```js
const user = await getUser(id);          // wait
const dept = await getDepartment(dId);   // wait again
const tasks = await getTasks(id);        // and again
```

**Fix.** Anything that doesn't need the previous line's result starts at
the same time:

```js
const [user, dept, tasks] = await Promise.all([
  getUser(id),
  getDepartment(dId),
  getTasks(id),
]);
```

Three waits become one. Go through every page and every API route, and for
each `await` ask: *does this line use anything the line above produced?* If
not, batch it.

**Related: no N+1 queries.** One query per list item is the worst form of
this:

```js
// BAD: 1 query for the list + 1 per intern
for (const intern of interns) intern.dept = await getDepartment(intern.deptId);

// GOOD: 2 queries total, however long the list is
const depts = await db.query("SELECT * FROM departments WHERE id = ANY($1)", [ids]); // Postgres
// MySQL:                     "SELECT * FROM departments WHERE id IN (?)", [ids]
```

Or use a single `JOIN`. Most ORMs have an `include` / `with` / `populate`
option that does this for you; make sure it's on.

---

## 3. Make `/health` cheap

The gateway calls your `/health` whenever it refreshes the catalog (every
15 seconds while someone is using it). It must answer fast and must never
be the slow part of anyone's page.

- **Do one trivial database ping**, not a real query:
  `SELECT 1`. The contract wants `checks.database` to be honest
  (RIZURF_API_TEMPLATE.md SS-2), not thorough.
- **No** row counts, **no** calls to other services, **no** loading
  configuration from the database, **no** authentication middleware in
  front of it.
- **Time-box every check** so one hanging dependency reports `degraded`
  instead of hanging the whole endpoint:

```js
async function check(fn, ms = 800) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
    return true;
  } catch {
    return false;
  }
}

app.get("/health", async (req, res) => {
  const database = await check(() => db.query("SELECT 1"));
  res.json({
    status: database ? "ok" : "degraded",
    service: "intern-database",   // your id
    version: "1.4.0",
    checks: { database },
  });
});
```

- **Cold starts.** The first `/health` after a quiet period is slowest (the
  1–1.7 s numbers above are mostly this). Keep the code that `/health`
  imports small. Don't pull your entire app into it, and create database
  clients lazily at the first query rather than at import time. Moving to
  the right region (section 1) also shortens every cold start's first query.

**If `/health` returns `403` or `401` (as attendance does above),** the
gateway can't read it at all and shows the app as down. On Vercel this is
almost always **Deployment Protection** (Vercel Authentication or Password
Protection) switched on for Production. Turn it off for Production, or add
`/health` and `/openapi.json` to its exceptions. They must be public
(SS-2, SS-3).

---

## 4. Serve `/openapi.json` from memory, not rebuilt per request

The document only changes when you deploy. Build it once:

```js
// Built once when the module loads, not on every request.
const OPENAPI = JSON.stringify(buildOpenApiDocument());

app.get("/openapi.json", (req, res) => {
  res.set("content-type", "application/json");
  res.set("cache-control", "public, max-age=60");
  res.send(OPENAPI);
});
```

If it's a static file, serve it as a static file. Never query the database
to produce it.

---

## 5. The gateway calls you make: do them cheaply, without breaking the rules

### 5a. Session check (`/oauth/introspect`): run it *alongside* your data, not *before* it

MICROAPP_AUTH.md §5 says to check on **every** signed-in request with **no
cache**. That stays. But you don't have to *wait* for the answer before you
start loading the page's data:

```js
// Before: introspect, THEN load data (two round trips of waiting)
if (!(await gatewaySessionIsLive(session))) return redirectToSignIn();
const data = await loadPageData(session);

// After: start both, check the answer before sending anything
const [live, data] = await Promise.all([
  gatewaySessionIsLive(session),
  loadPageData(session),
]);
if (!live) return redirectToSignIn();   // data is thrown away, never shown
return render(data);
```

Nothing is shown to a signed-out person, and the check is still on every
request. It just no longer adds its own round trip. **Only do this for
reads.** For anything that *changes* data (POST, PUT, DELETE), keep checking
first and writing second.

### 5b. Service-to-service tokens (`client_credentials`): reuse them until they expire

A `client_credentials` access token is valid for its `expires_in` (in
seconds, returned with the token). Asking the gateway for a fresh one before
**every** outgoing call doubles every call. Keep it until shortly before it
expires. Tokens are issued **per target service** (`audience`), so cache one
per audience:

```js
const tokens = new Map(); // audience -> { token, expiresAt }

async function getAccessToken(audience, scope = "") {
  const key = `${audience} ${scope}`;
  const hit = tokens.get(key);
  // 30 s of margin so a token never expires mid-request.
  if (hit && Date.now() < hit.expiresAt - 30_000) return hit.token;

  const response = await fetch(`${GATEWAY_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" }, // the gateway takes JSON, not form data
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.GATEWAY_CLIENT_ID,
      client_secret: process.env.GATEWAY_CLIENT_SECRET,
      audience,                // the target service's id, e.g. "intern-database"
      ...(scope && { scope }), // optional, space-separated; defaults to everything granted
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  const { access_token, expires_in } = await response.json();
  tokens.set(key, { token: access_token, expiresAt: Date.now() + expires_in * 1000 });
  return access_token;
}

// Usage: one token request per ~5 minutes instead of one per call.
const res = await fetch(`${INTERN_DB_URL}/api/interns?email=${encodeURIComponent(email)}`, {
  headers: { authorization: `Bearer ${await getAccessToken("intern-database")}` },
  signal: AbortSignal.timeout(5000),
});
```

If a call comes back `401` with a cached token (it was revoked early),
delete that entry and retry once with a fresh token.

This is safe: a token is only a proof that *this app* is allowed to call,
and it expires on its own. It is **not** the same as caching a *person's*
session check, which §5a still does every time.

### 5c. JWKS: fetch once per process

Already in MICROAPP_AUTH.md §3: keep the gateway's public keys in memory and
re-fetch only when a token arrives with a `kid` you don't have. If your code
fetches `/.well-known/jwks.json` per request, fix that first. It's a free
round trip saved on every sign-in.

---

## 6. Reuse database connections

Opening a database connection costs several round trips (TCP, TLS, auth)
before the first query even runs. On serverless it's easy to accidentally
open one per request.

- **Create the client/pool once and keep it on `globalThis`**, so hot
  reloads and separate route bundles share it:

```js
const g = globalThis;
export const db = g.__db ??= createPool({ connectionString: process.env.DATABASE_URL, max: 3 });
```

- **Keep the pool small** (2–5). Every serverless instance has its own
  pool, and many instances × a big pool exhausts the database's connection
  limit, which shows up as *random* failures under load.
- **Supabase: use the pooled connection string** (Transaction mode, port
  **6543**), not the direct one (5432). The direct one has a low connection
  cap that serverless apps hit quickly.

---

## 7. Make queries themselves cheaper

Only after sections 1–6, since those are bigger:

- **Index what you filter and sort by.** Any column in a `WHERE`, `JOIN`, or
  `ORDER BY` on a table with more than a few hundred rows. Check with
  `EXPLAIN` (Postgres: `EXPLAIN ANALYZE`). A `Seq Scan` / `type: ALL` on a
  big table is the smell.
- **Select only the columns you use.** `SELECT *` drags large text/JSON
  columns over the network for nothing.
- **Paginate lists.** Return 20–50 rows with a cursor or `limit`/`offset`,
  never "everything", and document the parameters in `/openapi.json`.
- **Count cheaply.** Don't load every row just to show a total.

---

## 8. Cache what's safe to cache

Reference data that changes rarely (department lists, job titles, office
locations, dropdown options) can be kept briefly instead of re-queried on
every request:

```js
const memo = new Map();
async function cached(key, ttlMs, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  memo.set(key, { value, at: Date.now() });
  return value;
}

const departments = await cached("departments", 60_000, () => db.query("SELECT id, name FROM departments"));
```

**Never cache:**
- anything decided per person (their permissions, their records) across
  different people;
- session / sign-in checks (MICROAPP_AUTH.md §5);
- anything where showing a stale value is wrong, not just old: balances,
  approvals, statuses someone is about to act on.

For public, non-personal GET endpoints you can also let Vercel's CDN cache
the response: `cache-control: public, s-maxage=30, stale-while-revalidate=300`.
**Never** put that header on a response that depends on who is signed in.

---

## 9. Reliability: fail fast, fail clearly

Speed and reliability are the same problem at the edges. A slow dependency
becomes a hung page.

- **Every outgoing `fetch` gets a timeout.** `fetch` has none by default, so
  one hung dependency hangs your request until the platform kills it:
  `fetch(url, { signal: AbortSignal.timeout(5000) })`.
- **Retry only safe things, once.** Retry a failed GET or a token request
  once with a short delay. Never auto-retry a POST that creates or charges
  something unless it carries an idempotency key.
- **Don't make people wait for side effects.** Logging, analytics,
  "last seen" updates and emails don't need to finish before the response.
  In Next.js use `after(() => …)` from `next/server`; on Vercel otherwise
  use `waitUntil` from `@vercel/functions`. Do **not** just leave a promise
  un-awaited: serverless may freeze the process and the work silently never
  happens.
- **Return the standard error shape** (RIZURF_API_TEMPLATE.md) with the
  right status: `503` when a dependency is down, not a `500` with a stack
  trace, and never a `200` with an error inside.
- **Keep `/health` honest.** `degraded` when a dependency is down, so the
  gateway can tell people rather than showing a green light over a broken
  app.

---

## 10. Measure: before and after

Do this **before** changing anything, keep the numbers, and repeat after.

```bash
# Where your code runs (second part of the id)
curl -sI https://YOUR-APP/health | grep -i x-vercel-id

# How long things take: run each 3 times, since the first is a cold start
for i in 1 2 3; do curl -s -o /dev/null -w "health %{time_total}s\n" https://YOUR-APP/health; done
for i in 1 2 3; do curl -s -o /dev/null -w "openapi %{time_total}s\n" https://YOUR-APP/openapi.json; done
```

To find *which part* of a slow endpoint is slow, add a `Server-Timing`
header. It shows up in the browser DevTools Network tab → Timing:

```js
const t0 = performance.now();
const rows = await db.query(/* … */);
const t1 = performance.now();
const body = render(rows);
res.set("server-timing", `db;dur=${(t1 - t0).toFixed(0)}, render;dur=${(performance.now() - t1).toFixed(0)}`);
```

A number that's roughly *(number of sequential queries × 150–300 ms)* means
you're in the wrong region (section 1) or awaiting in sequence (section 2).
A single large number on one query means indexes (section 7).

---

## 11. Checklist (definition of done)

- [ ] Functions run in the region nearest the database (`x-vercel-id` second part matches; `vercel inspect` shows no `[iad1]` unless the DB is in US East)
- [ ] `/health`: public (no 401/403), `SELECT 1`-level check with a timeout, **< 300 ms** warm
- [ ] `/openapi.json`: public, built once, **< 150 ms** warm
- [ ] No independent `await`s in sequence on any page or API route; no N+1 loops
- [ ] Session check (`/oauth/introspect`) runs alongside data loading on reads, still on every request, never cached
- [ ] `client_credentials` token reused until 30 s before expiry
- [ ] JWKS fetched once per process
- [ ] One small DB pool per process on `globalThis`; Supabase uses the pooled (6543) string
- [ ] Filtered/sorted columns indexed; lists paginated; no `SELECT *` on wide tables
- [ ] Every outgoing `fetch` has a timeout; side effects run after the response
- [ ] Before/after numbers from section 10 recorded, typical signed-in page **< 500 ms**

When you've done this, redeploy and tell the gateway team. The Explore page
and the notification bell pick up the new health status within a minute.
