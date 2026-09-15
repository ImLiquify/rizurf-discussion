# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PulseFeedback is a Rizurf-gateway microapp: a workplace feedback/messaging tool that runs behind a central OAuth gateway (`GATEWAY_URL`), not its own login system. The gateway issues short-lived (15 min) signed access tokens and identity tokens; this service verifies them against the gateway's JWKS and never accepts unsigned identity. See `MICROAPP_AUTH.md` and `RIZURF_API_TEMPLATE.md` for the full platform contract this app must follow.

**The entire frontend is one file:** [index.html](index.html) — inline `<style>` and a single inline `<script>` (~5,600 lines total), vanilla JS, no build step, no framework. It is mirrored byte-for-byte (except one line) into [dist/index.html](dist/index.html), which is what the server actually serves in both local dev and production.

**`src/*.jsx` (React + react-router) is a disconnected, unused prototype.** `npm run dev` / `vite build` build this React app, but nothing serves its output — the real app is the static `dist/index.html`. Do not extend `src/`; edit `index.html` directly. Likewise `server/index.js` and `api/health.js` are earlier/orphaned experiments — the real backend is `server/rizurfApi.js`, and the real Vercel entrypoint is `api/index.js`.

## Commands

```bash
npm run dev:api      # start the real backend (server/rizurfApi.js) on PORT (default 3001), serves dist/index.html
npm run start:xampp  # start local XAMPP MySQL, then dev:api (see server/start-xampp.ps1)
npm run db:setup      # provision the local XAMPP database (server/setup-xampp.ps1)
npm run db:stop       # stop the local XAMPP MySQL (server/stop-xampp.ps1)
```

There is no test suite, linter, or type checker in this repo — verification is manual (local XAMPP MySQL + browser), or curl against the running API. `npm run dev` / `npm run build` / `npm run preview` (Vite) only build the unused `src/` React prototype — running them proves nothing about the real app.

**After any change to `index.html`, mirror it into `dist/index.html`** (the server serves `dist/`, browsers should be pointed at the dev server, not the raw `index.html`). The only intentional difference between the two files is the logo asset path (`assets/logo.png` in `index.html` → the built hashed path in `dist/index.html`). Verify with:
```bash
diff <(sed 's/\r$//' index.html) <(sed 's/\r$//' dist/index.html)
```
which must show only that one line.

## Architecture

### Auth flow (backend: `server/sessionAuth.js`, `server/rizurfApi.js`)
- Visiting `/` with no session starts the gateway's OAuth authorization-code flow (`gatewayAuthorizeUrl()`); the callback (`?code=`) exchanges the code for a signed identity token (`exchangeAuthorizationCode`), verified via the gateway's JWKS (RS256), then a first-party session is minted: an HMAC-signed, HttpOnly, `SameSite=Lax` cookie (`setSession`/`readSession`) valid for 15 minutes, matching the gateway token's own lifetime.
- All other application API routes require `Authorization: Bearer <gateway access token>`, independently verified against the same JWKS (see `verifyGatewayToken`, `expectedUse: 'access'`).
- **`gatewaySessionIsLive()` must be called on every request that needs live liveness — never cached.** It fails open (returns `true`) if the gateway is unreachable, by design. Do not add caching here even for performance; this is a hard platform requirement (MICROAPP_AUTH.md §5), not an oversight.
- `resolveIdentityAccount()` (`server/feedbackRepository.js`) is the single place a gateway identity becomes a local `users` row — it must update `permission_role` from the gateway's `role` claim on every call, even for an existing (e.g. intern-directory-sourced) row, or a user's real admin/manager standing silently reverts.

### Role model
- `role_title` (column on `users`) is a job title, sourced from the intern directory sync — cosmetic, not an access-control field.
- `permission_role` is the gateway's real access-control claim (`admin` / `supervisor` / `hr` / `user`). `isPrivilegedRole(role)` (`server/rizurfApi.js`) = `role === 'admin' || role === 'supervisor'`. "Supervisor" is shown in the UI as **"manager"**. `hr` is deliberately not privileged.
- Privileged (admin/manager) users have full oversight: every DM, group thread, org thread, and the public wall.

### Messaging model (feedback-as-messages)
DMs, group chats, and the org channel all reuse the existing `feedback` (message) + `comments` (reply) + `reactions` tables rather than separate `threads`/`messages` tables — this keeps all the existing feed-assembly, comment-threading, and reaction machinery working for private messages with only additive columns (`visibility`, `target_type`). Groups are the one genuinely new concept, backed by `feedback_groups` + `group_members` (see `server/schema.sql`).
- **`target_type`**: `'user'` (DM, `target_id` = recipient id), `'company'` (the existing public Employee Wall post, `target_id='company'`, unrelated to `'org'` despite the similar name), `'group'` (`target_id` = `feedback_groups.id`), `'org'` (`target_id` = the fixed sentinel `'organization'` — one shared company-wide channel every employee can read/post into, with legacy backward-compatibility for older per-employee `target_id` rows via `OR t.created_by = viewerId` in `listTopicsInContainer`).
- **`topics`** group a conversation's messages inside a container (DM/group/org) — see `createTopic`/`listTopicsInContainer`/`listMyTopics` in `server/feedbackRepository.js`. `topic_reads` tracks per-user read state for unread badges.
- **Group leadership (Discord-style)**: a group's `created_by` user is its leader. Leader OR privileged (admin/manager) can manage members and settings (`PATCH/DELETE /api/groups/:groupId`, `POST/DELETE /api/groups/:groupId/members/:userId`); anyone can create a group; membership rules are enforced server-side, not just hidden in the UI.
- **Access control is enforced in `feedbackRepository.js` predicates** (`canViewFeedback`, `canViewTopic`, the `oversightFor`/`participantId`/`groupMemberId` params on `listFeedback`), not just by hiding UI — always add a matching repository-level check when adding a new route that reads or writes a `feedback`/`topic` row, since a known id is otherwise a bypass.

### Frontend structure (`index.html`, all in the one inline `<script>`)
- `CURRENT_USER`, `EMPLOYEES`, `myGroups`, `myTopics`, `conversationMessages`, `activeContainer`/`activeTopic` are the main client-side state; there is no framework/reactivity — render functions are called explicitly after state mutation (e.g. `renderFeedbacksTab()`, `renderTopicList()`, `renderConversationMessages()`).
- `loadBackendData()` does the full initial load; `refreshPublicFeed()` is a lightweight 45s background poll of just `/api/feedback` (public wall) — do not widen this back into a full reload, that was a deliberate perf fix.
- An open topic is kept live by `startTopicPolling()`/`stopTopicPolling()`, a 3s interval scoped to the single open topic (`pollActiveTopicMessages()`), started in `openTopic()` and stopped in `backToTopicList()`/`openContainer()`. This is the closest practical substitute for real-time push on a plain Vercel serverless Express app (no WebSocket/SSE support) — a true realtime service (Pusher/Ably) would be a larger, separate change.
- Sending a message is optimistic: a `pending: true` message object is appended to `conversationMessages` immediately (rendered as "Sending…" via `chatMessageBubbleHtml()`'s `statusHtml`) and reconciled against the server response and any poll that lands first — see `sendFeedbacksMessage()`. When touching this path, preserve the dedupe-by-id logic; the reconciliation exists specifically to prevent duplicate/flickering message rows on a send-vs-poll race.

### Deployment (Vercel)
`vercel.json` rewrites every route to `api/index.js`, whose handler awaits `ready` (the exported `ensureSchemaCompatibility()` promise from `server/database.js`) and then delegates to the same Express app used locally — so `server/rizurfApi.js` is the one source of truth for both environments, there is no separate serverless-only code path. `ensureSchemaCompatibility()` runs idempotent `information_schema`-probed `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` migrations on every cold start (see `server/database.js` and mirror any schema change into `server/schema.sql` too, which is the fresh-install reference). On Vercel the MySQL pool is capped to `connectionLimit: 1` (`server/config.js`) — **`Promise.all()` around DB queries does not achieve real concurrency in production**; the only real lever for latency there is reducing round-trip count (fewer, wider queries), not parallelizing.

### External services
`server/internApi.js` and `server/departmentApi.js` pull from separate gateway-registered services (intern directory, department names) via OAuth2 client-credentials, each with a short in-memory cache; both fail soft (return stale/empty data) rather than erroring, since a directory sync failure shouldn't break the app.

## Git workflow used in this repo

Every deploy to `main` in this project's history follows the same pattern — preserve it:
1. `git branch backup/main-before-<name> main && git push origin backup/main-before-<name>` (cheap, instant revert point).
2. Sanity checks: `node --check` on touched server files; the `dist/index.html` diff above; confirm no leftover test/dev-only routes (e.g. a temporary `/__test_login` bypass route, if one was added for local testing, must be removed before committing).
3. Commit only the exact touched files (never a blanket `git add -A`), push to `main`.
