import { config } from './config.js';
import { unreadBadges } from './feedbackRepository.js';

// App-icon badge in the gateway's "Your apps" (MICROAPP_BADGES.md): each
// person's total unread chat messages, pushed whenever it changes. Uses the
// same CLIENT_ID/CLIENT_SECRET as the directory sync; the gateway admin must
// grant that client `gateway:badges` for this service. Never throws — a badge
// must never break the action that changed the count. Awaited by callers
// (not run after the response): on Vercel, work after the response can be
// frozen before it runs. Returns a summary for the /cron/badges report.
export async function publishUnreadBadges(userIds) {
  const summary = { people: userIds.length, updated: 0, unknown: [], errors: [] };
  if (!config.clientId || !config.clientSecret) { summary.errors.push('CLIENT_ID / CLIENT_SECRET not set'); return summary; }
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
      const text = await response.text();
      if (!response.ok) { console.error('[badges]', response.status, text); summary.errors.push(`${response.status} ${text}`); continue; }
      const result = JSON.parse(text || '{}');
      summary.updated += result.updated || 0;
      summary.unknown.push(...(result.unknown || []));
    }
  } catch (error) {
    console.error('[badges] could not publish:', error);
    summary.errors.push(String(error.message || error));
  }
  return summary;
}
