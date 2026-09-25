# App icon badges: showing a count on your app's icon in the gateway

For the team, or the coding agent, working on **one microapp** that wants a
number on its icon in the gateway's **Your apps** page, like the red "3" on a
phone's home screen: unread messages, requests waiting for approval, tasks
due today.

**How it works:** your app **tells the gateway** each person's count whenever
it changes. The gateway stores it and shows it the next time that person opens
Your apps. The gateway never asks your app, so Your apps stays fast however
slow any app is.

---

## 1. Get permission (once, done by a gateway admin)

Your app needs an **API client** (a client ID and secret). You may already
have one if your app calls other apps (MICROAPP_AUTH.md §10).

A gateway admin opens **API clients** → your client → **Edit scopes**, finds
**your app** in the list, ticks **`gateway:badges`** ("publish this app's icon
badges") and saves.

That grant is **per app**: a client can only set badges on the app it was
granted for, never on anyone else's.

Keep the client ID and secret in your app's server environment variables
(e.g. `GATEWAY_CLIENT_ID`, `GATEWAY_CLIENT_SECRET`). **Never** put them in
browser code.

---

## 2. Send counts

```
POST https://web-omega-two-47.vercel.app/api/badges
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{
  "service": "attendance-api",
  "badges": [
    { "email": "someone@example.com", "count": 3 },
    { "email": "other@example.com",   "count": 0 }
  ]
}
```

- **`service`**: your app's service id (the `service` field of your `/health`).
- **`badges`**: up to **500** people per request. Each has:
  - `email`: the person's email. Matching ignores upper/lower case. Or use
    **`sub`**, the gateway user id from the identity token's `sub` claim, if
    you store that instead.
  - `count`: a whole number from 0 to 99,999. **`0` clears the badge.** Above
    99 the icon shows "99+".
- **Send the total, not the change.** `count` is the person's current number
  ("3 unread"), not "+1". Sending the same value twice is harmless.

**Response** (`200`):

```json
{ "service": "attendance-api", "updated": 1, "unknown": ["other@example.com"] }
```

`unknown` lists people who have no gateway account yet (they've never signed
in). That's normal, not an error. Their badge appears once they have an
account and you send it again.

**Errors** use the standard error envelope:

| Status | Meaning |
|---|---|
| `401` | Missing or wrong client ID / secret |
| `403` | This client doesn't have `gateway:badges` for that `service`; ask an admin (section 1) |
| `422` | Bad body: missing `service`, empty `badges`, a count that isn't 0–99,999, or over 500 entries |

---

## 3. Code (Node / Next.js server side)

```js
// lib/gatewayBadges.js — server only
const GATEWAY_URL = process.env.GATEWAY_URL; // https://web-omega-two-47.vercel.app
const auth =
  "Basic " +
  Buffer.from(`${process.env.GATEWAY_CLIENT_ID}:${process.env.GATEWAY_CLIENT_SECRET}`).toString("base64");

/**
 * Publish badge counts. Never throws: a badge is a nicety, and it must never
 * break the action that changed the count.
 * @param {{ email: string, count: number }[]} badges
 */
export async function publishBadges(badges) {
  if (badges.length === 0) return;
  try {
    for (let i = 0; i < badges.length; i += 500) {
      const response = await fetch(`${GATEWAY_URL}/api/badges`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ service: "attendance-api", badges: badges.slice(i, i + 500) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) console.error("[badges]", response.status, await response.text());
    }
  } catch (error) {
    console.error("[badges] could not reach the gateway:", error);
  }
}
```

Call it **after** the change is saved, with the affected people's **new
totals**:

```js
// e.g. a leave request was submitted: the supervisor now has one more to review
await saveLeaveRequest(request);
const pending = await countPendingApprovalsFor(request.supervisorEmail);
await publishBadges([{ email: request.supervisorEmail, count: pending }]);
```

```js
// e.g. the person opened the requests page: their "new" count is now 0
await publishBadges([{ email: currentUser.email, count: 0 }]);
```

On Vercel, if you don't want the user to wait for this call, run it after the
response with `after(() => publishBadges(...))` (Next.js, from `next/server`)
or `waitUntil` (`@vercel/functions`). Don't leave it un-awaited: the function
can be frozen before it runs.

Any other language: it's one HTTP POST with Basic auth and a JSON body.

---

## 4. Rules, so the number can be trusted

- **Every change, both ways.** Send an update when the count goes **up** and
  when it goes **down**, including to `0`. A badge that never clears is
  worse than no badge.
- **Something the person can act on.** Unread, waiting for them, due today.
  Not "total records" and not a number that's always there.
- **Don't send the count on every page load.** Send it when the underlying
  thing changes (and optionally once a night as a full refresh, in batches
  of 500, to fix anything that drifted).
- **Counts only.** No names, titles or message text: the icon only has room
  for a number, and the gateway doesn't store anything else.
- **Nothing for people outside your app.** Only send badges for people your
  app actually serves.

---

## 5. Checklist

- [ ] An admin has granted **`gateway:badges`** for **your app** to your API client
- [ ] Client ID and secret are server-side environment variables, not in browser code
- [ ] Counts are sent after the change is saved, as totals, for everyone affected
- [ ] The count drops (to `0` when cleared) when the person deals with the items
- [ ] A failed badge call is logged but never breaks the user's action
- [ ] Tested: send a count for yourself → it shows on your icon in **Your apps** after a refresh; send `0` → it disappears
