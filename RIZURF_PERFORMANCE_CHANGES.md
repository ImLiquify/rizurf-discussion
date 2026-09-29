# Making a Rizurf microapp fast: what we changed in Rizurf Discussion

Every speed fix made to **Rizurf Discussion** (PulseDiscussion, Express +
MySQL on Vercel), in order of how much each one saved, with the reason and
the change. Hand it to the team, or the coding agent, working on another app
and ask them to check each item against their app.

It applies the gateway's `MICROAPP_PERFORMANCE.md` and adds what we found on
top. Two rules from the platform still hold and nothing here breaks them:

- **The gateway session check runs on every request and is never cached**
  (`MICROAPP_AUTH.md` §5). We made it cheaper, never skipped it.
- `/health` and `/openapi.json` must answer quickly (the gateway polls them).

Targets: `/health` under 300 ms, a signed-in page under 500 ms, clicks that
feel instant.

---

## 1. Run the app in the same region as the database and the gateway

**Problem.** Vercel functions default to Washington (`iad1`). Our MySQL server
and the gateway are in Singapore/Malaysia, so every query and every session
check crossed the Pacific, about **230 ms each**. A page that ran 6 queries
spent over a second just waiting.

**Change.** `vercel.json`:
```json
{ "regions": ["sin1"] }
```

**Result.** The single biggest win. `/health` now answers in about 100 ms.

**Check yours.** Where is your database? Put your functions in the nearest
Vercel region. Nothing else on this list makes up for being on the wrong
continent.

---

## 2. Index the columns your hot queries filter on

**Problem.** A column added later by a migration (`ALTER TABLE ... ADD COLUMN`)
gets **no index** unless you add one. Our `feedback.topic_id` (which chat a
message belongs to) had an index only in the fresh-install `schema.sql`, not
in the migration that real databases ran. So every chat list, every message
load and every unread count read **the whole messages table**. It got slower
as messages piled up, and felt like "the whole app is slow".

**Change.** An idempotent migration that runs on startup:
```js
const [has] = await pool.query(
  "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' AND INDEX_NAME = 'idx_feedback_topic_created' LIMIT 1"
);
if (!has.length) await pool.query('ALTER TABLE feedback ADD INDEX idx_feedback_topic_created (topic_id, created_at)');
```
A **composite** index `(topic_id, created_at)` serves "latest message in this
chat", "messages after my last read" and "messages in order" straight from the
index.

**Check yours.**
- For every query that runs on page load or on a timer, look at its `WHERE`
  and `JOIN ... ON` columns. Each should have an index, ideally in the order
  the query uses them (equality column first, then the range/sort column).
- **Compare your live database against your schema file.** If the schema file
  was written after some migrations, it can have indexes the real database
  never got. Run `SHOW INDEX FROM <table>` on production.
- `EXPLAIN` a slow query. `type: ALL` means a full table scan.

---

## 3. Queries anything polls must be set-based, not per-row

**Problem.** The gateway reads our app-icon badge counts every minute
(`MICROAPP_BADGES.md`). Our first version ran a **subquery per user**,
recounting messages separately for each person. It returned 500 on
production (too slow for a real directory of people), and while it ran it
competed with everyone's clicks for the same small database server.

**Change.** Build the "who can see what" pairs once, then count in a single
indexed join:
```sql
SELECT u.email, COUNT(*) AS count
FROM (
  SELECT id AS topic_id, created_by AS user_id FROM topics
  UNION SELECT id, target_id FROM topics WHERE target_type IN ('user', 'org')
  UNION SELECT t.id, gm.user_id FROM topics t JOIN group_members gm ON gm.group_id = t.target_id WHERE t.target_type = 'group'
  UNION SELECT t.id, all_users.id FROM topics t JOIN users all_users ON all_users.removed_at IS NULL
    WHERE t.target_type = 'org' AND t.target_id = 'organization'
) access
JOIN users u ON u.id = access.user_id AND u.removed_at IS NULL AND u.email <> ''
LEFT JOIN topic_reads r ON r.topic_id = access.topic_id AND r.user_id = u.id
JOIN feedback f ON f.topic_id = access.topic_id
  AND f.created_at > COALESCE(r.last_read_at, '1970-01-02')   -- in the ON, so the index range applies
  AND f.sender_id <> u.id
GROUP BY u.email
LIMIT 5000
```

**Check yours.** Any query that loops (in SQL or in JS) once per user, once
per row or once per item, especially one on a timer or on every page load.
Turn it into one query with a `JOIN` and `GROUP BY`. Put range conditions in
the `ON` clause so the index can serve them.

---

## 4. Cache slow external syncs, and write in one batch

**Problem.** Every `/api/employees` call (and the page polled it) ran the whole
directory sync: a gateway token request, calls to the intern directory and the
department directory, then **one INSERT per person**. That was the ~6–10 s
"loading" delay.

**Change.**
- **One multi-row insert** instead of one per person:
  `INSERT INTO users (...) VALUES (...), (...), ... ON DUPLICATE KEY UPDATE ...`
  (15 rows: about 600 ms → 300 ms, and one round trip however many rows).
- **Skip the sync if it ran in the last 60 s.** Read the freshness from the
  database, `MAX(synced_at)` compared to `NOW()`, both in MySQL's clock. Don't
  compare to Node's `Date.now()`: the server's clock can disagree with the
  database's, and the cache then silently never hits. It also survives a
  serverless cold start, which an in-memory cache doesn't.
- Concurrent requests on one warm instance share a single in-flight sync
  instead of each starting their own.
- External calls **fail soft**: if the directory is down, serve what's in the
  database instead of erroring.

**Result.** A cached `/api/employees` went from about 6 s to about 15 ms.

---

## 5. Overlap the session check with the page's data

**Problem.** Every signed-in request must ask the gateway whether the session
is still live (`/oauth/introspect`, never cached). Waiting for that answer
before starting the database queries added a full round trip to every page.

**Change.** On **read** (`GET`) requests, start the session check and the data
queries at the same time. Hold the response until the check answers; if the
session turns out dead, send 401 and none of the data.
```js
// auth middleware, session GET:
request.sessionLive = gatewaySessionStatus(session).then(status => status !== 'inactive');

// every response goes through this:
function afterLiveCheck(response, send) {
  const live = response.req.sessionLive;
  if (!live) return send();
  live.then(ok => ok ? send() : response.status(401).json({ error: { code: 'UNAUTHORIZED' } }));
}
```
**Writes** (`POST`/`PATCH`/`DELETE`) still check first and write second. Never
write before the check.

---

## 6. Fewer round trips per request

On serverless every query is a network round trip, so their **number** matters
more than their size.

- **Parallel where independent:** `Promise.all([...])` for queries that don't
  depend on each other. On Vercel the MySQL pool is `connectionLimit: 3` so
  up to 3 really run at once (1 made `Promise.all` queue, and 10+ risks
  exhausting a small database's connections across many function instances).
- **Merge sequential lookups:** e.g. "who is the viewer and are they an admin"
  as one query instead of two.
- **Compare before you write:** our identity lookup ran two `UPDATE`s on
  every request "just in case". It now reads first and only writes what
  changed, which is usually nothing.
- **Startup migrations:** one `information_schema` query for every table's
  columns instead of one per table, and one `ALTER TABLE` with every missing
  column instead of one per column. These run on every cold start.
- **One endpoint, not three:** a screen that needed three lists now asks one
  endpoint that returns their union.

---

## 7. Don't poll more than you need

Every request pays the uncachable session check, so each timer has a real
cost.

- **Replace "refetch everything every 10 s"** with small, targeted polls: our
  open chat polls **only that chat**, every 3 s. The public feed polls every
  45 s. Directories, groups and settings refresh only when something happens.
- **Stop timers when the screen closes** (leaving a chat stops its poll).
- **Presence / keep-alive pings:** once a minute, and only while the tab is
  visible (`document.visibilityState === "visible"`).
- **Don't reload the whole app to update one thing.** Opening a chat used to
  refetch every group, topic and person just to clear one unread count; now
  it updates that count locally.
- **Fetch rarely-changing data once**, not on every poll.

---

## 8. Make it feel instant in the browser

- **Optimistic sends:** show the message immediately as "Sending…", reconcile
  it with the server's answer. Dedupe by id so a poll arriving at the same
  moment can't double it.
- **Skeleton rows on first paint** instead of a blank pane, so the page never
  looks empty while loading.
- **Keep lists on a failed refresh.** A failed request keeps what's on
  screen; it never renders as an empty list.
- **Never put slow work before the response.** Our first badge version
  awaited a call to the gateway on every send and read, adding its full
  round trip to each click. If work doesn't change what the person sees,
  don't make them wait for it. On Vercel you can't simply "run it after
  responding" either: the function can be frozen once the response is sent.
  Either do it before responding because it's needed, or move it out of the
  request, as the pull-based badges did.

---

## 9. Keep the platform endpoints fast

- **`/health`** runs `SELECT 1` **time-boxed to 800 ms** (report `degraded`,
  don't hang), and does **not** wait for startup migrations. Neither does
  `/openapi.json`: both are answered before the migration promise, so a cold
  start can't make the gateway's poll time out.
- **`/openapi.json`** is serialised once at startup and served with
  `cache-control: public, max-age=60`.
- **Every outgoing `fetch` has a 5 s timeout** (`signal: AbortSignal.timeout(5000)`):
  JWKS, introspect, token exchange, directory calls. One hung dependency must
  never hang the app.

---

## 10. Checklist

- [ ] Vercel region = the database's region (`vercel.json` `regions`)
- [ ] Every column in a hot `WHERE` / `JOIN` is indexed on the **live** database (`SHOW INDEX`), composite where the query uses two
- [ ] No per-row / per-user loops in queries that run on page load or on a timer
- [ ] External directory syncs are cached (freshness in DB time) and batch-inserted
- [ ] Session GETs overlap the introspect call with data loading; writes check first
- [ ] Independent queries run in `Promise.all`; pool limit 3 on Vercel
- [ ] No unconditional writes on read paths ("compare, then write")
- [ ] Polls are scoped to what's on screen, stop when it closes, pause when the tab is hidden
- [ ] Sends are optimistic; first paint shows skeletons; failed loads keep the old data
- [ ] Nothing slow is awaited before a response unless the response needs it
- [ ] `/health` time-boxed and not behind migrations; `/openapi.json` prebuilt; every fetch has a timeout
- [ ] Measured: `/health` < 300 ms, a signed-in page < 500 ms
