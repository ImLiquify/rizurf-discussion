import { config } from './config.js';

// The department directory (department-api / department-zeta) maps the
// department_id an intern carries (e.g. "DEP-0001") to a readable name
// ("Software engineering"). Same gateway client-credentials flow as the
// intern pull, different audience and scope.

const BASE_URL = (process.env.DEPARTMENT_API_BASE_URL || 'https://department-zeta.vercel.app').replace(/\/+$/, '');
const AUDIENCE = process.env.DEPARTMENT_API_AUDIENCE || 'department-api';
const SCOPE = 'department:read';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken(correlationId) {
  if (cachedToken && cachedTokenExpiresAt > Date.now() + 30_000) return cachedToken;
  if (!config.clientId || !config.clientSecret) throw new Error('Missing CLIENT_ID / CLIENT_SECRET');

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(`${config.gatewayUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
    },
    body: JSON.stringify({ grant_type: 'client_credentials', audience: AUDIENCE, scope: SCOPE }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Gateway token request failed with status ${response.status}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Gateway token response did not contain access_token');

  cachedToken = payload.access_token;
  cachedTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return cachedToken;
}

let cachedDeptMap = null;
let cachedDeptMapExpiresAt = 0;

// Map of department_id -> name. Cached for a few minutes; never throws — a
// department service that is down just means ids are shown until it recovers.
export async function getDepartmentMap(correlationId) {
  if (cachedDeptMap && cachedDeptMapExpiresAt > Date.now()) return cachedDeptMap;
  try {
    const response = await fetch(`${BASE_URL}/api/departments`, {
      headers: {
        Authorization: `Bearer ${await getAccessToken(correlationId)}`,
        Accept: 'application/json',
        ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Department API request failed with status ${response.status}`);
    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : (payload?.data || []);
    cachedDeptMap = new Map(list.map(dept => [String(dept.id), dept.name]));
    cachedDeptMapExpiresAt = Date.now() + 5 * 60_000;
  } catch {
    cachedDeptMap = cachedDeptMap || new Map();
  }
  return cachedDeptMap;
}
