import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { databaseIsHealthy, ensureSchemaCompatibility } from './database.js';
import { fetchInterns } from './internApi.js';
import * as feedbacks from './feedbackRepository.js';
import { clearSession, exchangeAuthorizationCode, gatewayAuthorizeUrl, gatewaySessionIsLive, noStoreHeaders, readSession, setSession, verifyGatewayToken } from './sessionAuth.js';

const app = express();
const startedAt = Date.now();
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDist = path.join(projectRoot, 'dist');
const MAX_LIMIT = 100;

function discovery(name, purpose, inputs, outputs, relatedEndpoints = []) {
  return { name, purpose, use_when: [purpose], do_not_use_when: [], inputs, outputs,
    requires: ['A valid Rizurf access token'], related_endpoints: relatedEndpoints,
    tags: name.toLowerCase().split(/\s+/) };
}
function operation(summary, scope, metadata) {
  return { summary, security: [{ bearerAuth: [scope] }], 'x-rizurf': metadata };
}
function publicOperation(summary, metadata) { return { summary, 'x-rizurf': metadata }; }

const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'PulseFeedback API', version: '1.0.0',
    description: 'Collect and review workplace feedback, threaded comments, and private remarks. It also reads synchronized intern profiles for employee-facing feedback workflows.',
    'x-rizurf': {
      domain: 'Human Resources', owner: 'pulsefeedback-team', app_url: '/', category: 'Customer Management',
      industries: ['Human Resources'],
      use_cases: ['Collect employee feedback', 'Review workplace suggestions', 'Browse intern profiles'],
      capabilities: [
        { name: 'Manage Feedback', icon: '💬', description: 'Create and review workplace feedback and its discussion threads.',
          does: ['Read feedback', 'Create feedback', 'Discuss feedback'], best_for: 'Teams collecting recognition and improvement ideas.',
          endpoints: ['GET /api/feedback', 'POST /api/feedback', 'GET /api/feedback/{feedbackId}/comments', 'POST /api/feedback/{feedbackId}/comments'] },
        { name: 'Browse People', icon: '👥', description: 'Read people participating in PulseFeedback and refresh intern profiles.',
          does: ['List feedback participants', 'Refresh intern profiles'], best_for: 'Employee directory and feedback targeting experiences.',
          endpoints: ['GET /api/employees', 'GET /api/interns'] },
        { name: 'Keep Remarks', icon: '📝', description: 'Store a caller-owned private note about a participant.',
          does: ['List private remarks', 'Create private remarks', 'Delete private remarks'], best_for: 'Personal follow-up notes that are not part of public feedback.',
          endpoints: ['GET /api/private-remarks', 'POST /api/private-remarks', 'DELETE /api/private-remarks/{remarkId}'] }
      ],
      workflows: [
        { name: 'Give feedback', steps: ['GET /api/employees', 'POST /api/feedback', 'POST /api/feedback/{feedbackId}/comments'] },
        { name: 'Refresh intern directory', steps: ['GET /api/interns', 'GET /api/employees'] }
      ], related_services: ['intern-database']
    }
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: {
    '/health': { get: publicOperation('Report service and database health.', discovery('Check Health', 'Check whether PulseFeedback can serve requests.', [], ['status', 'service', 'checks'])) },
    '/openapi.json': { get: publicOperation('Read this API contract.', discovery('Read API Contract', 'Discover available PulseFeedback operations.', [], ['openapi', 'paths'])) },
    '/api/employees': { get: operation('List local feedback participants.', 'intern:read', discovery('List Participants', 'Read participants available for feedback.', ['limit', 'offset'], ['data'], ['GET /api/interns'])) },
    '/api/interns': { get: operation('Synchronize and list intern profiles.', 'intern:read', discovery('List Interns', 'Refresh and read profiles from the intern service.', ['limit', 'offset'], ['data', 'synced'], ['GET /api/employees'])) },
    '/api/me': { get: operation('Read the signed-in caller profile.', 'feedback:read', discovery('Read My Profile', 'Read the local account of the person signed in to this microapp.', [], ['data'], ['GET /api/employees'])) },
    '/api/feedback': {
      get: operation('List workplace feedback.', 'feedback:read', discovery('List Feedback', 'Read feedback filtered by sender or target.', ['targetId', 'senderId', 'limit', 'offset'], ['data'])),
      post: operation('Create workplace feedback.', 'feedback:write', discovery('Create Feedback', 'Submit feedback for a participant or the company.', ['senderId', 'targetId', 'targetName', 'content', 'isAnonymous'], ['id'], ['GET /api/feedback']))
    },
    '/api/feedback/{feedbackId}/comments': {
      get: operation('List comments on feedback.', 'feedback:read', discovery('List Comments', 'Read a feedback item discussion thread.', ['feedbackId', 'limit', 'offset'], ['data'], ['GET /api/feedback'])),
      post: operation('Create a feedback comment.', 'feedback:write', discovery('Create Comment', 'Add a comment or reply to feedback.', ['feedbackId', 'senderId', 'parentId', 'text', 'isAnonymous'], ['id'], ['GET /api/feedback/{feedbackId}/comments']))
    },
    '/api/feedback/{feedbackId}/reactions': {
      post: operation('Toggle an emoji reaction.', 'feedback:write', discovery('Toggle Reaction', 'Add or remove one emoji reaction on a feedback item or a comment.', ['feedbackId', 'reaction', 'commentId'], ['reacted'], ['GET /api/feedback']))
    },
    '/api/private-remarks': {
      get: operation('List a caller-owned private remarks.', 'remark:read', discovery('List Private Remarks', 'Read private follow-up notes by author.', ['authorId', 'limit', 'offset'], ['data'])),
      post: operation('Create a private remark.', 'remark:write', discovery('Create Private Remark', 'Save a private follow-up note.', ['authorId', 'targetId', 'content'], ['id'], ['GET /api/private-remarks']))
    },
    '/api/private-remarks/{remarkId}': {
      delete: operation('Delete a private remark.', 'remark:write', discovery('Delete Private Remark', 'Remove one caller-owned private note.', ['remarkId', 'authorId'], [], ['GET /api/private-remarks']))
    }
  }
};

function routeKey(pathname) {
  if (openapi.paths[pathname]) return pathname;
  if (/^\/api\/feedback\/[^/]+\/comments$/.test(pathname)) return '/api/feedback/{feedbackId}/comments';
  if (/^\/api\/feedback\/[^/]+\/reactions$/.test(pathname)) return '/api/feedback/{feedbackId}/reactions';
  if (/^\/api\/private-remarks\/[^/]+$/.test(pathname)) return '/api/private-remarks/{remarkId}';
  return null;
}
function sendJson(response, status, body) { response.status(status).type('application/json').json(body); }
function sendError(response, request, status, code, message, details = null) {
  response.status(status).type('application/json').json({ error: { code, message, correlation_id: request.correlationId, details } });
}
function requiredScopes(operationDefinition) {
  return (operationDefinition.security || []).flatMap(requirement => Object.values(requirement)).flat();
}

// Every scope this service's own OpenAPI declares, derived so it can't drift
// from the routes. A first-party session (a signed-in human using the
// microapp) is authorised for all of them — none of these endpoints is
// gated on the gateway role.
const FIRST_PARTY_SCOPES = [...new Set(
  Object.values(openapi.paths).flatMap(pathDefinition =>
    Object.values(pathDefinition).flatMap(operationDefinition => requiredScopes(operationDefinition)))
)];
function pagination(request, response) {
  const parse = (name, fallback, minimum) => {
    const value = request.query[name];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(String(value)) || Number(value) < minimum) return null;
    return Number(value);
  };
  const limit = parse('limit', 50, 1); const offset = parse('offset', 0, 0);
  if (limit === null || offset === null) {
    sendError(response, request, 422, 'VALIDATION_ERROR', 'limit must be at least 1 and offset must be at least 0.', { fields: ['limit', 'offset'] });
    return null;
  }
  return { limit: Math.min(limit, MAX_LIMIT), offset };
}
function validText(value) { return typeof value === 'string' && value.trim(); }

// A real sync means: a token round trip to the gateway, a call to
// intern-database, a call to the department directory, and a write to the
// users table — each an external network hop, and on Vercel most requests
// land on a cold instance with no warm in-memory cache to skip any of it.
// That chain was most of the ~10s the intern directory took to load.
//
// Gate it on the database's own record of the last sync (survives a cold
// start, unlike a process-memory cache) so routine polling reads the local
// directory without repeating that chain every time, and de-dupe concurrent
// callers on the same warm instance onto one in-flight sync.
const INTERN_SYNC_TTL_MS = 60_000;
let internSyncInFlight = null;

async function synchronizeInterns(correlationId, { force = false } = {}) {
  if (internSyncInFlight) return internSyncInFlight;
  internSyncInFlight = (async () => {
    try {
      if (!force && await feedbacks.isInternSyncFresh(INTERN_SYNC_TTL_MS / 1000)) {
        return 0;
      }
      const interns = await fetchInterns({ correlationId });
      await feedbacks.upsertInternUsers(interns);
      return interns.length;
    } finally {
      internSyncInFlight = null;
    }
  })();
  return internSyncInFlight;
}

app.use((request, response, next) => {
  const supplied = request.headers['x-correlation-id'];
  request.correlationId = typeof supplied === 'string' && supplied.trim() ? supplied.trim() : crypto.randomUUID();
  response.setHeader('x-correlation-id', request.correlationId);
  next();
});
app.use(cors({ origin: process.env.CLIENT_ORIGIN || false, credentials: true, preflightContinue: true }));
app.use(express.json({ limit: '100kb' }));

// The OpenAPI document is the single source of truth for both declared and enforced scopes.
app.use(async (request, response, next) => {
  const route = routeKey(request.path); const method = request.method.toLowerCase();
  if (!route) return next();
  const pathDefinition = openapi.paths[route];
  if (!pathDefinition[method]) {
    response.setHeader('allow', Object.keys(pathDefinition).map(value => value.toUpperCase()).join(', '));
    return sendError(response, request, 405, 'METHOD_NOT_ALLOWED', `${request.method} is not allowed on ${request.path}.`);
  }
  const operationDefinition = pathDefinition[method];
  if (!operationDefinition.security) return next();
  const required = requiredScopes(operationDefinition);
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization || '');

  // First-party path: the browser running this service's own microapp calls
  // these routes with the session cookie from the sign-in flow
  // (MICROAPP_AUTH.md section 4), not a gateway access token — the gateway
  // only mints those for service-to-service callers (section 10). A live
  // session is proof the gateway authenticated this person, so it stands in
  // for the scopes this service's own endpoints need, and gets the same
  // per-request liveness check every authenticated request gets (section 5).
  // The cookie is HMAC-signed, so a forged one fails readSession() — no
  // identity is ever trusted from a plain header (SS-25).
  if (!match) {
    const session = readSession(request);
    if (session && await gatewaySessionIsLive(session)) {
      request.auth = { ...session, token_use: 'session', scope: FIRST_PARTY_SCOPES.join(' ') };
      return next();
    }
    return sendError(response, request, 401, 'UNAUTHORIZED', 'Sign in or present a bearer token to use this endpoint.');
  }

  try {
    const claims = await verifyGatewayToken(match[1], 'access');
    const granted = new Set(String(claims.scope || '').split(/\s+/).filter(Boolean));
    const missing = required.filter(scope => !granted.has(scope));
    if (missing.length) return sendError(response, request, 403, 'FORBIDDEN', `This endpoint needs ${missing.join(', ')}.`, { required, granted: [...granted] });
    request.auth = claims;
    return next();
  } catch {
    return sendError(response, request, 401, 'UNAUTHORIZED', 'The bearer token is invalid.');
  }
});

app.get('/health', async (request, response) => {
  try { await databaseIsHealthy(); return sendJson(response, 200, { status: 'ok', service: config.serviceId, version: openapi.info.version, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), checks: { database: true } }); }
  catch { return sendJson(response, 200, { status: 'degraded', service: config.serviceId, version: openapi.info.version, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), checks: { database: false } }); }
});
app.get('/openapi.json', (_request, response) => sendJson(response, 200, openapi));

app.get('/api/employees', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try { try { await synchronizeInterns(request.correlationId); } catch (error) { console.warn('Intern synchronization unavailable:', error.message); }
    return sendJson(response, 200, { data: await feedbacks.listEmployees(page), ...page }); } catch (error) { return next(error); }
});
app.get('/api/interns', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try { const synced = await synchronizeInterns(request.correlationId, { force: true }); return sendJson(response, 200, { data: await feedbacks.listSyncedInterns(page), synced, ...page }); } catch (error) { return next(error); }
});
app.get('/api/me', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  try {
    // Resolve to the one canonical account for this identity (an existing
    // directory row when the email is known here), not a per-sub row.
    const localId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    let user = await feedbacks.getUserById(localId);
    if (!user) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No local account for this caller.');
    // A gateway-only account has no photo of its own; pull one from the
    // matching synced intern-directory row when this row is still missing it.
    if (!user.avatar || !user.department || user.department === 'General') {
      await feedbacks.backfillGatewayProfileFromDirectory(localId, user.email);
      user = await feedbacks.getUserById(localId);
    }
    return sendJson(response, 200, { data: user });
  } catch (error) { return next(error); }
});
app.get('/api/feedback', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try {
    const data = await feedbacks.listFeedback({ ...page, targetId: request.query.targetId, senderId: request.query.senderId });
    const ids = data.map(item => item.id);
    const viewerId = await feedbacks.findAccountIdByEmail(request.auth?.email)
      || (request.auth?.sub ? `gw_${request.auth.sub}`.slice(0, 50) : null);
    const [comments, reactions] = await Promise.all([
      feedbacks.listCommentsForFeedback(ids),
      feedbacks.listReactionsForFeedback(ids, viewerId)
    ]);

    // reactionsFor: "<feedbackId>\0<commentId>" -> { counts:{emoji:n}, mine:[emoji] }
    const reactionsFor = new Map();
    for (const row of reactions) {
      const key = `${row.feedbackId} ${row.commentId || ''}`;
      if (!reactionsFor.has(key)) reactionsFor.set(key, { counts: {}, mine: [] });
      const bucket = reactionsFor.get(key);
      bucket.counts[row.reaction] = Number(row.count);
      if (Number(row.mine)) bucket.mine.push(row.reaction);
    }
    const applyReactions = (target, feedbackId, commentId) => {
      const bucket = reactionsFor.get(`${feedbackId} ${commentId || ''}`);
      target.reactions = bucket ? bucket.counts : {};
      target.userReactions = bucket ? bucket.mine : [];
    };

    const byFeedback = new Map();
    for (const comment of comments) {
      applyReactions(comment, comment.feedbackId, comment.id);
      if (!byFeedback.has(comment.feedbackId)) byFeedback.set(comment.feedbackId, []);
      byFeedback.get(comment.feedbackId).push(comment);
    }
    for (const item of data) {
      item.comments = byFeedback.get(item.id) || [];
      applyReactions(item, item.id, '');
    }
    return sendJson(response, 200, { data, ...page });
  } catch (error) { return next(error); }
});
app.post('/api/feedback', async (request, response, next) => {
  const { senderId, targetId, targetName, content, isAnonymous = false } = request.body || {};
  if (![senderId, targetId, targetName, content].every(validText)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'senderId, targetId, targetName, and content are required.', { fields: ['senderId', 'targetId', 'targetName', 'content'] });
  try { return sendJson(response, 201, await feedbacks.createFeedback({ id: `fb_${crypto.randomUUID()}`, senderId, targetId, targetName, content: content.trim(), isAnonymous: Boolean(isAnonymous) })); } catch (error) { return next(error); }
});
app.get('/api/feedback/:feedbackId/comments', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try { if (!await feedbacks.feedbackExists(request.params.feedbackId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No feedback item with that id.');
    return sendJson(response, 200, { data: await feedbacks.listComments({ feedbackId: request.params.feedbackId, ...page }), ...page }); } catch (error) { return next(error); }
});
app.post('/api/feedback/:feedbackId/comments', async (request, response, next) => {
  const { senderId, parentId = null, text, isAnonymous = false } = request.body || {};
  if (![senderId, text].every(validText)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'senderId and text are required.', { fields: ['senderId', 'text'] });
  try { if (!await feedbacks.feedbackExists(request.params.feedbackId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No feedback item with that id.');
    return sendJson(response, 201, await feedbacks.createComment({ id: `cm_${crypto.randomUUID()}`, feedbackId: request.params.feedbackId, parentId, senderId, text: text.trim(), isAnonymous: Boolean(isAnonymous) })); } catch (error) { return next(error); }
});
const ALLOWED_REACTIONS = new Set(['❤️', '👏', '💡', '🙌']);
app.post('/api/feedback/:feedbackId/reactions', async (request, response, next) => {
  const { reaction, commentId = '' } = request.body || {};
  if (!ALLOWED_REACTIONS.has(reaction)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'reaction must be one of ❤️ 👏 💡 🙌.', { fields: ['reaction'] });
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const feedbackId = request.params.feedbackId;
  try {
    if (!await feedbacks.feedbackExists(feedbackId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No feedback item with that id.');
    if (commentId && !await feedbacks.commentExists(commentId, feedbackId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No comment with that id on this feedback.');
    const userId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    return sendJson(response, 200, await feedbacks.toggleReaction({ userId, feedbackId, commentId: commentId || '', reaction }));
  } catch (error) { return next(error); }
});
app.get('/api/private-remarks', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  if (!validText(request.query.authorId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'authorId is required.', { fields: ['authorId'] });
  try { return sendJson(response, 200, { data: await feedbacks.listPrivateRemarks({ authorId: request.query.authorId, ...page }), ...page }); } catch (error) { return next(error); }
});
app.post('/api/private-remarks', async (request, response, next) => {
  const { authorId, targetId, content } = request.body || {};
  if (![authorId, targetId, content].every(validText)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'authorId, targetId, and content are required.', { fields: ['authorId', 'targetId', 'content'] });
  try { return sendJson(response, 201, await feedbacks.createPrivateRemark({ id: `remark_${crypto.randomUUID()}`, authorId, targetId, content: content.trim() })); } catch (error) { return next(error); }
});
app.delete('/api/private-remarks/:remarkId', async (request, response, next) => {
  if (!validText(request.query.authorId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'authorId is required.', { fields: ['authorId'] });
  try { if (!await feedbacks.deletePrivateRemark({ id: request.params.remarkId, authorId: request.query.authorId })) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No private remark with that id.');
    return response.status(204).end(); } catch (error) { return next(error); }
});

app.use('/assets', express.static(path.join(publicDist, 'assets'), { index: false }));
async function serveMicroapp(request, response) {
  Object.entries(noStoreHeaders).forEach(([key, value]) => response.setHeader(key, value));
  if (request.path === '/' && typeof request.query.code === 'string') {
    try {
      const identity = await exchangeAuthorizationCode(request.query.code);
      // Provision the signed-in person as a local account (MICROAPP_AUTH.md
      // section 11) so their feedback and comments have a stable owner row.
      // The gateway has already vouched for this identity, so a provisioning
      // failure is logged and swallowed rather than blocking the sign-in —
      // the same policy synchronizeInterns() uses for the intern pull.
      try { await feedbacks.resolveIdentityAccount(identity); }
      catch (error) { console.warn(`User provisioning failed [${request.correlationId}]:`, error.message); }
      setSession(response, identity);
      return response.redirect(302, '/');
    }
    catch { clearSession(response); return response.redirect(302, gatewayAuthorizeUrl()); }
  }
  const session = readSession(request);
  if (!session || !await gatewaySessionIsLive(session)) { clearSession(response); return response.redirect(302, gatewayAuthorizeUrl()); }
  return response.sendFile(path.join(publicDist, 'index.html'));
}
app.get(['/', '/me'], (request, response, next) => { serveMicroapp(request, response).catch(next); });

app.use((request, response) => sendError(response, request, 404, 'RESOURCE_NOT_FOUND', `No route for ${request.path}.`));
app.use((error, request, response, _next) => {
  console.error(`Request failed [${request.correlationId}]:`, error.message);
  if (response.headersSent) return;
  if (error.type === 'entity.parse.failed') {
    return sendError(response, request, 422, 'VALIDATION_ERROR', 'The request body must be valid JSON.');
  }
  return sendError(response, request, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred.');
});

// `ready` resolves once the schema check has run — and never rejects. A DB
// that is down or not yet configured must not take down `/health` and
// `/openapi.json`: SS-2 requires those stay public and answer even when a
// dependency is unreachable, and `/health` below already reports that via
// `checks.database`, which is the correct place for this failure to surface.
export const ready = ensureSchemaCompatibility().catch(error => {
  console.error(`Schema compatibility check failed: ${error.message}`);
});

if (!process.env.VERCEL) {
  ready.then(() => app.listen(config.port, () => {
    console.log(`${config.serviceId} listening on ${config.publicUrl}`);
  }));
}

export default app;