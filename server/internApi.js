import { config } from './config.js';
import { getDepartmentMap } from './departmentApi.js';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function requireInternClientConfig() {
  const values = {
    INTERN_API_BASE_URL: config.internApiBaseUrl,
    INTERN_API_AUDIENCE: config.internApiAudience,
    CLIENT_ID: config.clientId,
    CLIENT_SECRET: config.clientSecret
  };
  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
  }
}

async function getInternAccessToken(correlationId) {
  if (cachedAccessToken && cachedAccessTokenExpiresAt > Date.now() + 30_000) {
    return cachedAccessToken;
  }

  requireInternClientConfig();

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(`${config.gatewayUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      audience: config.internApiAudience,
      scope: 'intern:read'
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) throw new Error(`Gateway token request failed with status ${response.status}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Gateway token response did not contain access_token');

  cachedAccessToken = payload.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

function getInternName(intern) {
  return [intern.first_name, intern.last_name].filter(Boolean).join(' ').trim()
    || intern.name
    || intern.full_name
    || `Intern ${intern.id}`;
}

function getInternId(intern) {
  return intern.id ?? intern.intern_id ?? intern.ref_number;
}

function getInternsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.interns)) return payload.interns;
  return [];
}

async function internApiGet(pathname, searchParams, correlationId) {
  requireInternClientConfig();
  const url = new URL(`${config.internApiBaseUrl}${pathname}`);
  for (const [key, value] of Object.entries(searchParams || {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getInternAccessToken(correlationId)}`,
      Accept: 'application/json',
      ...(correlationId ? { 'X-Correlation-ID': correlationId } : {})
    },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Intern API GET ${pathname} failed with status ${response.status}`);
  return response.json();
}

let cachedRoleMap = null;
let cachedRoleMapExpiresAt = 0;

// intern-database returns `role_id`, not a role name; GET /api/roles maps the
// two. Cached for a few minutes so a directory sync of many interns is one
// extra request, not one per intern.
async function getRoleMap(correlationId) {
  if (cachedRoleMap && cachedRoleMapExpiresAt > Date.now()) return cachedRoleMap;
  try {
    const payload = await internApiGet('/api/roles', null, correlationId);
    const roles = getInternsFromResponse(payload);
    cachedRoleMap = new Map(roles.map(role => [String(role.id), role.name]));
    cachedRoleMapExpiresAt = Date.now() + 5 * 60_000;
  } catch {
    cachedRoleMap = cachedRoleMap || new Map();
  }
  return cachedRoleMap;
}

export async function fetchInterns({ limit = 100, offset = 0, correlationId } = {}) {
  const [payload, roleMap, departmentMap] = await Promise.all([
    internApiGet('/api/interns', {
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
      offset: Math.max(Number(offset) || 0, 0)
    }, correlationId),
    getRoleMap(correlationId),
    getDepartmentMap(correlationId)
  ]);

  return getInternsFromResponse(payload).map(intern => ({
    externalId: String(getInternId(intern)),
    id: String(getInternId(intern)),
    refNumber: intern.ref_number || null,
    name: getInternName(intern),
    role: roleMap.get(String(intern.role_id)) || intern.position || intern.role || 'Intern',
    department: departmentMap.get(String(intern.department_id))
      || intern.department || intern.department_id || 'Internship',
    email: intern.email_address || intern.email || null,
    avatar: intern.photo_url || intern.avatar || intern.profile_photo || null,
    skills: Array.isArray(intern.skills) ? intern.skills : []
  }));
}

// The whole directory, page by page (the API caps a page at 100). `complete`
// is false if paging looked broken (a page repeating the previous one, i.e.
// the API ignoring offset) or ran past the safety cap — callers must never
// treat an incomplete list as "everyone who's still here".
export async function fetchAllInterns({ correlationId } = {}) {
  const PAGE = 100;
  const all = [];
  const seen = new Set();
  for (let offset = 0; offset < 50 * PAGE; offset += PAGE) {
    const page = await fetchInterns({ limit: PAGE, offset, correlationId });
    if (page.length && page.every(intern => seen.has(intern.externalId))) return { interns: all, complete: false };
    for (const intern of page) {
      if (seen.has(intern.externalId)) continue;
      seen.add(intern.externalId);
      if (intern.externalId !== 'undefined') all.push(intern);
    }
    // Counted before dropping id-less entries, so a short page really is the last.
    if (page.length < PAGE) return { interns: all, complete: true };
  }
  return { interns: all, complete: false };
}