import { config } from './config.js';
import { unreadBadges } from './feedbackRepository.js';

// App-icon badge in the gateway's "Your apps" (MICROAPP_BADGES.md): each
// person's total unread chat messages, pushed whenever it changes. Uses the
// same CLIENT_ID/CLIENT_SECRET as the directory sync; the gateway admin must
// grant that client `gateway:badges` for this service. Never throws — a badge
// must never break the action that changed the count.
export async function publishUnreadBadges(userIds) {
  if (!config.clientId || !config.clientSecret || !userIds.length) return;
  const auth = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const badges = await unreadBadges(userIds.slice(i, i + 500));
      if (!badges.length) continue;
      const response = await fetch(`${config.gatewayUrl}/api/badges`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ service: config.serviceId, badges }),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) console.error('[badges]', response.status, await response.text());
    }
  } catch (error) {
    console.error('[badges] could not publish:', error);
  }
}

// Runs the publish after the response is sent. On Vercel the function is
// kept alive for it via the runtime's waitUntil (what @vercel/functions
// wraps); locally the process just keeps running.
export function publishUnreadBadgesLater(userIdsPromise) {
  const task = Promise.resolve(userIdsPromise).then(publishUnreadBadges).catch(error => console.error('[badges]', error));
  globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(task);
}
