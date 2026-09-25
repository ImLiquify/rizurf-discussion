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
    description: 'Collect and review workplace feedback and threaded comments. It also reads synchronized intern profiles for employee-facing feedback workflows.',
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
          endpoints: ['GET /api/employees', 'GET /api/interns'] }
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
      get: operation('List workplace feedback.', 'feedback:read', discovery('List Feedback', 'Read feedback filtered by sender or target.', ['targetId', 'senderId', 'visibility', 'participantId', 'groupMemberId', 'oversightFor', 'topicId', 'mine', 'limit', 'offset'], ['data'])),
      post: operation('Create workplace feedback.', 'feedback:write', discovery('Create Feedback', 'Submit feedback for a participant or the company.', ['senderId', 'targetId', 'targetName', 'content', 'isAnonymous'], ['id'], ['GET /api/feedback']))
    },
    '/api/feedback/counts': {
      get: operation('Read given/received feedback counts per employee.', 'feedback:read', discovery('Read Feedback Counts', 'Read a per-employee tally of given and received feedback, across public and private, for the Employee Wall; an admin or manager only.', [], ['data']))
    },
    '/api/feedback/{feedbackId}': {
      patch: operation('Edit a feedback item.', 'feedback:write', discovery('Edit Feedback', 'Update the text of a feedback item; the author, an admin, or a manager only.', ['feedbackId', 'content'], ['id'], ['GET /api/feedback'])),
      delete: operation('Delete a feedback item.', 'feedback:write', discovery('Delete Feedback', 'Remove a feedback item; the author, an admin, or a manager only.', ['feedbackId'], []))
    },
    '/api/feedback/{feedbackId}/comments': {
      get: operation('List comments on feedback.', 'feedback:read', discovery('List Comments', 'Read a feedback item discussion thread.', ['feedbackId', 'limit', 'offset'], ['data'], ['GET /api/feedback'])),
      post: operation('Create a feedback comment.', 'feedback:write', discovery('Create Comment', 'Add a comment or reply to feedback.', ['feedbackId', 'senderId', 'parentId', 'text', 'isAnonymous'], ['id'], ['GET /api/feedback/{feedbackId}/comments']))
    },
    '/api/feedback/{feedbackId}/comments/{commentId}': {
      patch: operation('Edit a comment.', 'feedback:write', discovery('Edit Comment', 'Update the text of a comment or reply; the author, an admin, or a manager only.', ['feedbackId', 'commentId', 'text'], ['id'], ['GET /api/feedback/{feedbackId}/comments'])),
      delete: operation('Delete a comment.', 'feedback:write', discovery('Delete Comment', 'Remove a comment or reply, and any replies nested under it; the author, an admin, or a manager only.', ['feedbackId', 'commentId'], []))
    },
    '/api/feedback/{feedbackId}/pin': {
      post: operation('Pin or unpin a message.', 'feedback:write', discovery('Pin Message', 'Pin a private message to the top of its conversation for everyone in it, or unpin it.', ['feedbackId', 'pinned'], ['pinned']))
    },
    '/api/feedback/{feedbackId}/hide': {
      post: operation('Hide a message for yourself.', 'feedback:write', discovery('Hide Message', 'Delete a chat message for yourself only ("delete for me"); everyone else still sees it.', ['feedbackId'], []))
    },
    '/api/feedback/{feedbackId}/star': {
      post: operation('Star or unstar a message.', 'feedback:write', discovery('Star Message', 'Star a private message for yourself only, or unstar it.', ['feedbackId', 'starred'], ['starred']))
    },
    '/api/feedback/{feedbackId}/reactions': {
      post: operation('Toggle an emoji reaction.', 'feedback:write', discovery('Toggle Reaction', 'Add or remove one emoji reaction on a feedback item or a comment.', ['feedbackId', 'reaction', 'commentId'], ['reacted'], ['GET /api/feedback']))
    },
    '/api/groups': {
      get: operation('List project groups.', 'feedback:read', discovery('List Groups', 'Read project groups, optionally restricted to the caller\'s own.', ['mine', 'limit', 'offset'], ['data'])),
      post: operation('Create a project group.', 'feedback:write', discovery('Create Group', 'Create a project group; the caller becomes its first member.', ['name'], ['id'], ['GET /api/groups']))
    },
    '/api/groups/{groupId}': {
      patch: operation('Rename or re-photo a project group.', 'feedback:write', discovery('Edit Group', 'Rename a project group or set its photo.', ['groupId', 'name', 'avatar'], ['id'], ['GET /api/groups'])),
      delete: operation('Delete a project group.', 'feedback:write', discovery('Delete Group', 'Delete a project group; its sub-groups and memberships go with it.', ['groupId'], []))
    },
    '/api/groups/{groupId}/members': {
      get: operation('List a group\'s members.', 'feedback:read', discovery('List Group Members', 'Read who belongs to a project group.', ['groupId'], ['data'])),
      post: operation('Add a member to a group.', 'feedback:write', discovery('Add Group Member', 'Add any employee to a project group; the group\'s leader (creator), an admin, or a manager only.', ['groupId', 'userId'], [], ['GET /api/groups/{groupId}/members']))
    },
    '/api/groups/{groupId}/members/{userId}': {
      patch: operation('Set a member\'s group role.', 'feedback:write', discovery('Set Group Role', 'Make a member a sub-admin or a regular member; the group owner only.', ['groupId', 'userId', 'role'], [])),
      delete: operation('Remove a group member.', 'feedback:write', discovery('Remove Group Member', 'Remove an employee from a project group.', ['groupId', 'userId'], [], ['GET /api/groups/{groupId}/members']))
    },
    '/api/topics': {
      get: operation('List topics.', 'feedback:read', discovery('List Topics', 'Read topics in one conversation, or every topic the caller participates in.', ['mine', 'targetType', 'targetId', 'search'], ['data'])),
      post: operation('Create a topic.', 'feedback:write', discovery('Create Topic', 'Start a new topic inside a DM, group, or the Organization thread.', ['targetType', 'targetId', 'name'], ['id'], ['GET /api/topics']))
    },
    '/api/topics/{topicId}/typing': {
      post: operation('Signal typing in a topic.', 'feedback:write', discovery('Signal Typing', 'Tell the other people in a topic that the caller is typing; lasts a few seconds.', ['topicId'], []))
    },
    '/api/attachments': {
      post: operation('Upload a chat attachment.', 'feedback:write', discovery('Upload Attachment', 'Upload an image or file (raw body, up to 3 MB; X-Filename and X-File-Type headers) to attach to a private message.', ['X-Filename', 'X-File-Type'], ['id', 'name', 'type', 'size'], ['POST /api/feedback']))
    },
    '/api/attachments/{attachmentId}': {
      get: operation('Download a chat attachment.', 'feedback:read', discovery('Read Attachment', 'Download an attachment; visible to whoever can see the message it belongs to.', ['attachmentId'], []))
    },
    '/api/topics/{topicId}/read': {
      post: operation('Mark a topic read.', 'feedback:write', discovery('Mark Topic Read', 'Record that the caller has read a topic up to now.', ['topicId'], []))
    },
    '/api/topics/{topicId}': {
      delete: operation('Delete a topic.', 'feedback:write', discovery('Delete Topic', 'Delete a topic; anyone can delete an empty one, admins and managers can delete any.', ['topicId'], []))
    }
  }
};

function routeKey(pathname) {
  if (openapi.paths[pathname]) return pathname;
  if (/^\/api\/feedback\/[^/]+\/comments\/[^/]+$/.test(pathname)) return '/api/feedback/{feedbackId}/comments/{commentId}';
  if (/^\/api\/feedback\/[^/]+\/comments$/.test(pathname)) return '/api/feedback/{feedbackId}/comments';
  if (/^\/api\/feedback\/[^/]+\/reactions$/.test(pathname)) return '/api/feedback/{feedbackId}/reactions';
  if (/^\/api\/feedback\/[^/]+\/pin$/.test(pathname)) return '/api/feedback/{feedbackId}/pin';
  if (/^\/api\/feedback\/[^/]+\/star$/.test(pathname)) return '/api/feedback/{feedbackId}/star';
  if (/^\/api\/feedback\/[^/]+\/hide$/.test(pathname)) return '/api/feedback/{feedbackId}/hide';
  if (/^\/api\/feedback\/[^/]+$/.test(pathname)) return '/api/feedback/{feedbackId}';
  if (/^\/api\/groups\/[^/]+\/members\/[^/]+$/.test(pathname)) return '/api/groups/{groupId}/members/{userId}';
  if (/^\/api\/groups\/[^/]+\/members$/.test(pathname)) return '/api/groups/{groupId}/members';
  if (/^\/api\/groups\/[^/]+$/.test(pathname)) return '/api/groups/{groupId}';
  if (/^\/api\/topics\/[^/]+\/read$/.test(pathname)) return '/api/topics/{topicId}/read';
  if (/^\/api\/topics\/[^/]+\/typing$/.test(pathname)) return '/api/topics/{topicId}/typing';
  if (/^\/api\/attachments\/[^/]+$/.test(pathname)) return '/api/attachments/{attachmentId}';
  if (/^\/api\/topics\/[^/]+$/.test(pathname)) return '/api/topics/{topicId}';
  return null;
}
// MICROAPP_PERFORMANCE.md §5a: on a session GET the introspect call runs
// alongside the route's data loading (request.sessionLive, set by the auth
// middleware) — nothing is sent until it answers, and a dead session gets
// the 401 instead of the data.
function afterLiveCheck(response, send) {
  const live = response.req.sessionLive;
  if (!live) return send();
  live.then(ok => {
    if (ok) return send();
    response.status(401).type('application/json').json({ error: { code: 'UNAUTHORIZED',
      message: 'Sign in or present a bearer token to use this endpoint.', correlation_id: response.req.correlationId, details: null } });
  });
}
function sendJson(response, status, body) { afterLiveCheck(response, () => response.status(status).type('application/json').json(body)); }
function sendError(response, request, status, code, message, details = null) {
  afterLiveCheck(response, () => response.status(status).type('application/json').json({ error: { code, message, correlation_id: request.correlationId, details } }));
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

// Only 'admin' and 'supervisor' (shown to the frontend as "manager") are
// privileged — 'hr' and 'user' are plain employees. Mirrors the frontend's
// mapRoleToView so Employee Wall visibility and API access agree.
function isPrivilegedRole(role) { return role === 'admin' || role === 'supervisor'; }

// Organization is one shared company-wide channel, not a private thread per
// employee — every 'org' topic/message uses this fixed sentinel as its
// target_id, the same way the public Company Wall uses target_id='company'.
// (An older design keyed 'org' rows by each employee's own id instead, for
// a private 1:1 thread with leadership; feedbackRepository.js's accessSql
// still honors that shape for rows written before this change.)
const ORG_SHARED_TARGET_ID = 'organization';

// Read-only viewer resolution for hot read paths (the feedback poll) that
// must not write on every call — see findViewerForRead's own comment.
async function resolveViewerForRead(auth) {
  const fallbackId = auth?.sub ? `gw_${auth.sub}`.slice(0, 50) : null;
  if (!auth?.email && !fallbackId) return { viewerId: null, isPrivileged: false };
  const user = await feedbacks.findViewerForRead(auth?.email, fallbackId);
  return { viewerId: user?.id || fallbackId, isPrivileged: isPrivilegedRole(user?.permissionRole) };
}

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
// preflightContinue must stay unset (false): with it true, the cors
// middleware only sets headers on an OPTIONS preflight and calls next()
// instead of answering it — nothing downstream ever handles OPTIONS (the
// scope-check middleware below returns 405 for a route it recognizes, or
// falls through to the 404 handler for one it doesn't), so a real
// cross-origin caller's preflight always failed once CLIENT_ORIGIN was set.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || false, credentials: true }));
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
  //
  // Reads (GET) don't wait for that check before starting — see
  // afterLiveCheck. Writes still check first and write second.
  if (!match) {
    const session = readSession(request);
    if (session) {
      const live = gatewaySessionIsLive(session);
      if (request.method === 'GET' || await live) {
        if (request.method === 'GET') request.sessionLive = live;
        request.auth = { ...session, token_use: 'session', scope: FIRST_PARTY_SCOPES.join(' ') };
        return next();
      }
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
const OPENAPI_JSON = JSON.stringify(openapi);
app.get('/openapi.json', (_request, response) => {
  response.set('cache-control', 'public, max-age=60').type('application/json').send(OPENAPI_JSON);
});

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
  const visibility = request.query.visibility === 'private' ? 'private' : 'public';
  // `mine=1` populates the caller's own Feedbacks-tab inbox: every DM, group
  // thread, and org thread they actually participate in — deliberately NOT
  // privilege-bypassed, so an admin's own inbox looks like anyone else's.
  // The privileged "see everything" bypass is reserved for an explicit
  // participantId/targetId oversight lookup (the Employee Wall panel).
  const mine = request.query.mine === '1' || request.query.mine === 'true';
  try {
    const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
    if (visibility === 'private' && !viewerId) {
      return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    }
    const data = await feedbacks.listFeedback({
      ...page, targetId: request.query.targetId, senderId: request.query.senderId,
      participantId: request.query.participantId, groupMemberId: request.query.groupMemberId,
      oversightFor: request.query.oversightFor, topicId: request.query.topicId, visibility, viewerId,
      viewerIsPrivileged: mine ? false : isPrivileged
    });
    const ids = data.map(item => item.id);
    const topicId = visibility === 'private' ? request.query.topicId : undefined;
    const [comments, reactions, typing] = await Promise.all([
      feedbacks.listCommentsForFeedback(ids),
      feedbacks.listReactionsForFeedback(ids, viewerId),
      topicId ? feedbacks.listTyping({ topicId, viewerId, viewerIsPrivileged: isPrivileged }) : null
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
    return sendJson(response, 200, { data, ...page, ...(typing && { typing }) });
  } catch (error) { return next(error); }
});
app.get('/api/feedback/counts', async (request, response, next) => {
  try {
    const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
    if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    if (!isPrivileged) return sendError(response, request, 403, 'FORBIDDEN', 'Only an admin or a manager can read feedback counts.');
    return sendJson(response, 200, { data: await feedbacks.getFeedbackCounts() });
  } catch (error) { return next(error); }
});
app.post('/api/feedback', async (request, response, next) => {
  const body = request.body || {};
  if (body.visibility === 'private') return createPrivateFeedback(request, response, next);
  const auth = request.auth || {};
  let senderId = body.senderId;
  // A first-party session is a browser signed in as one specific person —
  // never trust a body-supplied senderId there, or any signed-in employee
  // could post public feedback under a coworker's (or an admin's) name. A
  // bearer access token (a genuine service-to-service caller, e.g. another
  // Rizurf service posting feedback on behalf of a local user id it already
  // knows) keeps the documented senderId input, since it has no session
  // identity of its own to derive one from.
  if (auth.token_use === 'session') {
    if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    senderId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
  }
  const { targetId, targetName, content, isAnonymous = false } = body;
  if (![senderId, targetId, targetName, content].every(validText)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'senderId, targetId, targetName, and content are required.', { fields: ['senderId', 'targetId', 'targetName', 'content'] });
  try { return sendJson(response, 201, await feedbacks.createFeedback({ id: `fb_${crypto.randomUUID()}`, senderId, targetId, targetName, content: content.trim(), isAnonymous: Boolean(isAnonymous) })); } catch (error) { return next(error); }
});
app.patch('/api/feedback/:feedbackId', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const { content } = request.body || {};
  if (!validText(content)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'content is required.', { fields: ['content'] });
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    const callerId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    if (!await canModerateMessage(meta, callerId)) {
      return sendError(response, request, 403, 'FORBIDDEN', 'Only the author or someone who moderates this conversation can edit this.');
    }
    // Chat messages (private) are editable for one hour after sending, by
    // anyone — no admin/manager bypass. Age is measured in MySQL's clock
    // (ageSeconds), not Date.now() vs created_at: the two clocks disagree.
    if (meta.visibility === 'private' && Number(meta.ageSeconds) > 60 * 60) {
      return sendError(response, request, 403, 'FORBIDDEN', 'This message is more than an hour old and can no longer be edited.');
    }
    return sendJson(response, 200, await feedbacks.updateFeedbackContent({ id: request.params.feedbackId, content: content.trim() }));
  } catch (error) { return next(error); }
});
app.delete('/api/feedback/:feedbackId', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    const callerId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    // Chat messages: only their author deletes them (for everyone); anyone
    // else can only hide one for themselves (POST .../hide). Public wall
    // posts keep the moderator rule.
    if (meta.visibility === 'private' ? meta.senderId !== callerId : !await canModerateMessage(meta, callerId)) {
      return sendError(response, request, 403, 'FORBIDDEN', meta.visibility === 'private'
        ? 'You can only delete your own messages. Use "Delete for me" to hide someone else\'s.'
        : 'Only the author or someone who moderates this conversation can delete this.');
    }
    await feedbacks.deleteFeedback(request.params.feedbackId);
    return response.status(204).end();
  } catch (error) { return next(error); }
});

// Who besides the author may edit/delete a message: in a group, only its
// owner and sub-admins (company admins/managers get no bypass there — groups
// are run by their own admins); everywhere else, admins/managers.
async function canModerateMessage(meta, callerId) {
  if (meta.senderId === callerId) return true;
  if (meta.visibility === 'private' && meta.targetType === 'group') return isGroupManager(meta.targetId, callerId);
  return isPrivilegedRole((await feedbacks.getUserById(callerId))?.permissionRole);
}

async function isGroupManager(groupId, userId) {
  return ['owner', 'admin'].includes(await feedbacks.getGroupRole(groupId, userId));
}

// Private feedback (DM / group / Organization) — always sent into a topic.
// Unlike the public path above, the sender identity and anonymity are never
// taken from the client — a spoofed senderId here would be an actual
// privacy breach, not just misattributed authorship. targetType/targetId
// are derived entirely from the topic being posted into, never from the
// client: for a 'user' topic the direction flips per sender (so each
// message keeps the original per-row sender/target shape the access
// predicate expects); for 'group'/'org' it's always the topic's own
// target_id (a group id, or ORG_SHARED_TARGET_ID for the one shared
// Organization channel — fixed no matter who's posting).
async function createPrivateFeedback(request, response, next) {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const { topicId, content, attachmentId, replyToId } = request.body || {};
  if (!validText(topicId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'topicId is required.', { fields: ['topicId'] });
  if (!validText(content) && !validText(attachmentId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'content or attachmentId is required.', { fields: ['content', 'attachmentId'] });
  try {
    const senderId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    let text = validText(content) ? content.trim() : '';
    if (validText(attachmentId)) {
      const attachment = await feedbacks.getClaimableAttachment(attachmentId, senderId);
      if (!attachment) return sendError(response, request, 422, 'VALIDATION_ERROR', 'attachmentId must be your own, not-yet-sent upload.', { fields: ['attachmentId'] });
      // A caption-less attachment still gets text, so sidebar previews and
      // anything else that reads `content` show something meaningful.
      if (!text) text = `📎 ${attachment.filename}`;
    }
    if (validText(replyToId) && (await feedbacks.getFeedbackMeta(replyToId))?.topicId !== topicId) {
      return sendError(response, request, 422, 'VALIDATION_ERROR', 'replyToId must be a message in the same topic.', { fields: ['replyToId'] });
    }
    const topic = await feedbacks.getTopicById(topicId);
    if (!topic) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No topic with that id.');
    const senderUser = await feedbacks.getUserById(senderId);
    const senderIsPrivileged = isPrivilegedRole(senderUser?.permissionRole);
    if (!await feedbacks.canViewTopic({ topicId, viewerId: senderId, viewerIsPrivileged: senderIsPrivileged })) {
      return sendError(response, request, 403, 'FORBIDDEN', 'You do not have access to this topic.');
    }
    if (topic.targetType === 'group' && !senderIsPrivileged && !await feedbacks.isGroupMember(topic.targetId, senderId)) {
      return sendError(response, request, 403, 'FORBIDDEN', 'You must be a member of this group to post in it.');
    }
    const targetType = topic.targetType;
    const targetId = targetType === 'user'
      ? (senderId === topic.createdBy ? topic.targetId : topic.createdBy)
      : topic.targetId;
    let targetName;
    if (targetType === 'org') targetName = 'Organization';
    else if (targetType === 'group') targetName = (await feedbacks.getGroupById(topic.targetId))?.name || 'Group';
    else targetName = (await feedbacks.getUserById(targetId))?.name || 'Unknown';

    const created = await feedbacks.createFeedback({
      id: `fb_${crypto.randomUUID()}`, senderId, targetId, targetName,
      content: text, isAnonymous: false, visibility: 'private', targetType, topicId,
      attachmentId: validText(attachmentId) ? attachmentId : null,
      replyToId: validText(replyToId) ? replyToId : null
    });
    await Promise.all([
      feedbacks.markTopicRead({ topicId, userId: senderId }),
      feedbacks.clearTyping({ topicId, userId: senderId })
    ]);
    return sendJson(response, 201, created);
  } catch (error) { return next(error); }
}
// Shared by the three per-id routes below: with private rows now sharing the
// `feedback` table, an unguessable-but-known id is otherwise a bypass of
// every privacy rule — feedbackExists alone used to be the only check.
async function loadAccessibleFeedback(request, response, feedbackId) {
  const meta = await feedbacks.getFeedbackMeta(feedbackId);
  if (!meta) { sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No feedback item with that id.'); return null; }
  if (meta.visibility !== 'private') return meta;
  const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
  if (!viewerId) { sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.'); return null; }
  if (!await feedbacks.canViewFeedback({ feedbackId, viewerId, viewerIsPrivileged: isPrivileged })) {
    sendError(response, request, 403, 'FORBIDDEN', 'You do not have access to this feedback item.');
    return null;
  }
  return meta;
}

app.get('/api/feedback/:feedbackId/comments', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try {
    if (!await loadAccessibleFeedback(request, response, request.params.feedbackId)) return;
    return sendJson(response, 200, { data: await feedbacks.listComments({ feedbackId: request.params.feedbackId, ...page }), ...page });
  } catch (error) { return next(error); }
});
app.post('/api/feedback/:feedbackId/comments', async (request, response, next) => {
  const { parentId = null, text } = request.body || {};
  if (!validText(text)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'text is required.', { fields: ['text'] });
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    // A parentId must actually be a comment on THIS feedback item, or a
    // reply could be planted onto an unrelated (and possibly private)
    // thread the poster otherwise has no relationship to.
    if (parentId && !await feedbacks.commentExists(parentId, request.params.feedbackId)) {
      return sendError(response, request, 422, 'VALIDATION_ERROR', 'parentId must be an existing comment on this feedback item.', { fields: ['parentId'] });
    }
    let senderId; let isAnonymous;
    const auth = request.auth || {};
    if (meta.visibility === 'private') {
      // A reply in a private thread: sender and anonymity are never taken
      // from the client, same reasoning as createPrivateFeedback above.
      senderId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
      isAnonymous = false;
    } else if (auth.token_use === 'session') {
      // Same reasoning as POST /api/feedback: a browser session's own
      // identity is never optional, even on the public wall.
      if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
      senderId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
      isAnonymous = Boolean(request.body?.isAnonymous);
    } else {
      senderId = request.body?.senderId;
      if (!validText(senderId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'senderId is required.', { fields: ['senderId'] });
      isAnonymous = Boolean(request.body?.isAnonymous);
    }
    return sendJson(response, 201, await feedbacks.createComment({ id: `cm_${crypto.randomUUID()}`, feedbackId: request.params.feedbackId, parentId, senderId, text: text.trim(), isAnonymous }));
  } catch (error) { return next(error); }
});
app.patch('/api/feedback/:feedbackId/comments/:commentId', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const { text } = request.body || {};
  if (!validText(text)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'text is required.', { fields: ['text'] });
  try {
    if (!await loadAccessibleFeedback(request, response, request.params.feedbackId)) return;
    const comment = await feedbacks.getCommentMeta(request.params.commentId, request.params.feedbackId);
    if (!comment) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No comment with that id on this feedback.');
    const callerId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    const callerUser = await feedbacks.getUserById(callerId);
    if (comment.senderId !== callerId && !isPrivilegedRole(callerUser?.permissionRole)) {
      return sendError(response, request, 403, 'FORBIDDEN', 'Only the author, an admin, or a manager can edit this.');
    }
    return sendJson(response, 200, await feedbacks.updateCommentContent({ id: request.params.commentId, content: text.trim() }));
  } catch (error) { return next(error); }
});
app.delete('/api/feedback/:feedbackId/comments/:commentId', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  try {
    if (!await loadAccessibleFeedback(request, response, request.params.feedbackId)) return;
    const comment = await feedbacks.getCommentMeta(request.params.commentId, request.params.feedbackId);
    if (!comment) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No comment with that id on this feedback.');
    const callerId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    const callerUser = await feedbacks.getUserById(callerId);
    if (comment.senderId !== callerId && !isPrivilegedRole(callerUser?.permissionRole)) {
      return sendError(response, request, 403, 'FORBIDDEN', 'Only the author, an admin, or a manager can delete this.');
    }
    await feedbacks.deleteCommentById(request.params.commentId);
    return response.status(204).end();
  } catch (error) { return next(error); }
});
// Pin: shared with everyone in the conversation, and anyone in it may pin
// or unpin. Star: private to the caller. Both are chat-only (private rows).
app.post('/api/feedback/:feedbackId/pin', async (request, response, next) => {
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    if (meta.visibility !== 'private') return sendError(response, request, 422, 'VALIDATION_ERROR', 'Only chat messages can be pinned.');
    const { viewerId } = await resolveViewerForRead(request.auth);
    const pinned = Boolean(request.body?.pinned);
    await feedbacks.setPinned({ feedbackId: meta.id, pinnedBy: pinned ? viewerId : null });
    return sendJson(response, 200, { pinned });
  } catch (error) { return next(error); }
});
app.post('/api/feedback/:feedbackId/hide', async (request, response, next) => {
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    if (meta.visibility !== 'private') return sendError(response, request, 422, 'VALIDATION_ERROR', 'Only chat messages can be hidden.');
    const { viewerId } = await resolveViewerForRead(request.auth);
    await feedbacks.hideMessageForUser({ userId: viewerId, feedbackId: meta.id });
    return response.status(204).end();
  } catch (error) { return next(error); }
});
app.post('/api/feedback/:feedbackId/star', async (request, response, next) => {
  try {
    const meta = await loadAccessibleFeedback(request, response, request.params.feedbackId);
    if (!meta) return;
    if (meta.visibility !== 'private') return sendError(response, request, 422, 'VALIDATION_ERROR', 'Only chat messages can be starred.');
    const { viewerId } = await resolveViewerForRead(request.auth);
    const starred = Boolean(request.body?.starred);
    await feedbacks.setStarred({ userId: viewerId, feedbackId: meta.id, starred });
    return sendJson(response, 200, { starred });
  } catch (error) { return next(error); }
});
const ALLOWED_REACTIONS = new Set(['❤️', '👏', '💡', '🙌']);
app.post('/api/feedback/:feedbackId/reactions', async (request, response, next) => {
  const { reaction, commentId = '' } = request.body || {};
  if (!ALLOWED_REACTIONS.has(reaction)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'reaction must be one of ❤️ 👏 💡 🙌.', { fields: ['reaction'] });
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const feedbackId = request.params.feedbackId;
  try {
    if (!await loadAccessibleFeedback(request, response, feedbackId)) return;
    if (commentId && !await feedbacks.commentExists(commentId, feedbackId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No comment with that id on this feedback.');
    const userId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    return sendJson(response, 200, await feedbacks.toggleReaction({ userId, feedbackId, commentId: commentId || '', reaction }));
  } catch (error) { return next(error); }
});
app.get('/api/groups', async (request, response, next) => {
  const page = pagination(request, response); if (!page) return;
  try {
    let mine;
    if (request.query.mine === '1' || request.query.mine === 'true') {
      const { viewerId } = await resolveViewerForRead(request.auth);
      if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
      mine = viewerId;
    }
    // parentId: omitted lists every group; 'root' lists only top-level
    // groups; a specific group id lists that group's sub-groups.
    return sendJson(response, 200, { data: await feedbacks.listGroups({ mine, parentId: request.query.parentId, ...page }), ...page });
  } catch (error) { return next(error); }
});
// Groups are run by their own owner (creator) and the sub-admins the owner
// appoints — see isGroupManager. Company admins/managers get no bypass here.
app.post('/api/groups', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const { name, parentGroupId } = request.body || {};
  if (!validText(name)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'name is required.', { fields: ['name'] });
  try {
    const createdBy = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    let resolvedParentId = null;
    if (validText(parentGroupId)) {
      const parent = await feedbacks.getGroupById(parentGroupId);
      if (!parent) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No parent group with that id.');
      // One level of nesting only — a sub-group can't itself have sub-groups.
      if (parent.parentGroupId) return sendError(response, request, 422, 'VALIDATION_ERROR', 'A sub-group cannot itself have sub-groups.', { fields: ['parentGroupId'] });
      if (!await isGroupManager(parentGroupId, createdBy)) {
        return sendError(response, request, 403, 'FORBIDDEN', 'Only the group\'s owner or a sub-admin can create a sub-group.');
      }
      resolvedParentId = parentGroupId;
    }
    return sendJson(response, 201, await feedbacks.createGroup({ id: `grp_${crypto.randomUUID()}`, name: name.trim(), createdBy, parentGroupId: resolvedParentId }));
  } catch (error) { return next(error); }
});
app.get('/api/groups/:groupId/members', async (request, response, next) => {
  try {
    if (!await feedbacks.getGroupById(request.params.groupId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No group with that id.');
    return sendJson(response, 200, { data: await feedbacks.listGroupMembers(request.params.groupId) });
  } catch (error) { return next(error); }
});

// Resolves the caller and their role in :groupId, sending the error itself
// (and returning null) when the group is missing or the role isn't allowed.
async function requireGroupRole(request, response, allowed) {
  const auth = request.auth || {};
  if (!auth.sub) { sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.'); return null; }
  const group = await feedbacks.getGroupById(request.params.groupId);
  if (!group) { sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No group with that id.'); return null; }
  const callerId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
  const role = await feedbacks.getGroupRole(group.id, callerId);
  if (!allowed.includes(role)) {
    sendError(response, request, 403, 'FORBIDDEN', allowed.includes('admin')
      ? 'Only the group\'s owner or a sub-admin can do this.' : 'Only the group\'s owner can do this.');
    return null;
  }
  return { group, callerId, role };
}

app.post('/api/groups/:groupId/members', async (request, response, next) => {
  const { userId } = request.body || {};
  if (!validText(userId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'userId is required.', { fields: ['userId'] });
  try {
    const ctx = await requireGroupRole(request, response, ['owner', 'admin']);
    if (!ctx) return;
    if (!await feedbacks.getUserById(userId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No user with that id.');
    await feedbacks.addGroupMember({ groupId: ctx.group.id, userId, addedBy: ctx.callerId });
    return response.status(204).end();
  } catch (error) { return next(error); }
});
// Owner only: make a member a sub-admin ('admin') or back to 'member'.
app.patch('/api/groups/:groupId/members/:userId', async (request, response, next) => {
  const { role } = request.body || {};
  if (!['admin', 'member'].includes(role)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'role must be admin or member.', { fields: ['role'] });
  try {
    const ctx = await requireGroupRole(request, response, ['owner']);
    if (!ctx) return;
    if (request.params.userId === ctx.group.createdBy) return sendError(response, request, 422, 'VALIDATION_ERROR', 'The owner\'s role can\'t be changed.');
    if (!await feedbacks.setGroupMemberRole({ groupId: ctx.group.id, userId: request.params.userId, role })) {
      return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'That person is not in this group.');
    }
    return response.status(204).end();
  } catch (error) { return next(error); }
});
app.delete('/api/groups/:groupId/members/:userId', async (request, response, next) => {
  try {
    const ctx = await requireGroupRole(request, response, ['owner', 'admin']);
    if (!ctx) return;
    const targetRole = await feedbacks.getGroupRole(ctx.group.id, request.params.userId);
    if (targetRole === 'owner') return sendError(response, request, 422, 'VALIDATION_ERROR', 'The owner can\'t be removed from their own group.');
    // Sub-admins manage members, not each other.
    if (targetRole === 'admin' && ctx.role !== 'owner') return sendError(response, request, 403, 'FORBIDDEN', 'Only the group\'s owner can remove a sub-admin.');
    await feedbacks.removeGroupMember({ groupId: ctx.group.id, userId: request.params.userId });
    return response.status(204).end();
  } catch (error) { return next(error); }
});
app.patch('/api/groups/:groupId', async (request, response, next) => {
  const { name, avatar } = request.body || {};
  if (name !== undefined && !validText(name)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'name cannot be blank.', { fields: ['name'] });
  if (name === undefined && avatar === undefined) return sendError(response, request, 422, 'VALIDATION_ERROR', 'name or avatar is required.', { fields: ['name', 'avatar'] });
  try {
    const ctx = await requireGroupRole(request, response, ['owner', 'admin']);
    if (!ctx) return;
    return sendJson(response, 200, await feedbacks.updateGroup({
      groupId: ctx.group.id,
      name: name !== undefined ? name.trim() : undefined,
      avatar: avatar !== undefined ? (validText(avatar) ? avatar.trim() : null) : undefined
    }));
  } catch (error) { return next(error); }
});
app.delete('/api/groups/:groupId', async (request, response, next) => {
  try {
    const ctx = await requireGroupRole(request, response, ['owner']);
    if (!ctx) return;
    await feedbacks.deleteGroup(ctx.group.id);
    return response.status(204).end();
  } catch (error) { return next(error); }
});

app.get('/api/topics', async (request, response, next) => {
  try {
    const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
    if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    if (request.query.mine === '1' || request.query.mine === 'true') {
      // Deliberately not privilege-bypassed — see listMyTopics's own comment.
      return sendJson(response, 200, { data: await feedbacks.listMyTopics({ viewerId, viewerIsPrivileged: false }) });
    }
    const { targetType, targetId } = request.query;
    if (!['user', 'group', 'org'].includes(targetType) || !validText(targetId)) {
      return sendError(response, request, 422, 'VALIDATION_ERROR', 'targetType and targetId are required (or pass mine=1).', { fields: ['targetType', 'targetId'] });
    }
    if (targetType === 'group' && !isPrivileged && !await feedbacks.isGroupMember(targetId, viewerId)) {
      return sendError(response, request, 403, 'FORBIDDEN', 'You are not a member of this group.');
    }
    // 'org' is a single shared company-wide channel — every signed-in
    // employee is an implicit member, no membership check needed.
    const page = pagination(request, response); if (!page) return;
    const data = await feedbacks.listTopicsInContainer({ targetType, targetId, viewerId, search: request.query.search, ...page });
    return sendJson(response, 200, { data, ...page });
  } catch (error) { return next(error); }
});
app.post('/api/topics', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const { targetType, targetId, name } = request.body || {};
  if (!['user', 'group', 'org'].includes(targetType)) {
    return sendError(response, request, 422, 'VALIDATION_ERROR', 'targetType must be user, group, or org.', { fields: ['targetType'] });
  }
  if (!validText(name)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'name is required.', { fields: ['name'] });
  try {
    const createdBy = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    let resolvedTargetId;
    if (targetType === 'org') {
      // A single shared company-wide channel — any signed-in employee may
      // start a topic in it, same as decision for who may post in it.
      resolvedTargetId = ORG_SHARED_TARGET_ID;
    } else if (targetType === 'group') {
      if (!validText(targetId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'targetId is required.', { fields: ['targetId'] });
      if (!await feedbacks.getGroupById(targetId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No group with that id.');
      const creatorUser = await feedbacks.getUserById(createdBy);
      const creatorIsPrivileged = isPrivilegedRole(creatorUser?.permissionRole);
      if (!creatorIsPrivileged && !await feedbacks.isGroupMember(targetId, createdBy)) {
        return sendError(response, request, 403, 'FORBIDDEN', 'You must be a member of this group to create a topic in it.');
      }
      resolvedTargetId = targetId;
    } else {
      if (!validText(targetId)) return sendError(response, request, 422, 'VALIDATION_ERROR', 'targetId is required.', { fields: ['targetId'] });
      if (targetId === createdBy) return sendError(response, request, 422, 'VALIDATION_ERROR', 'You cannot start a topic with yourself.');
      if (!await feedbacks.getUserById(targetId)) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No user with that id.');
      // A DM is one continuous thread per pair of people — hand back the
      // existing one instead of starting a second.
      const [existing] = await feedbacks.listTopicsInContainer({ targetType: 'user', targetId, viewerId: createdBy, limit: 1, offset: 0 });
      if (existing) return sendJson(response, 200, existing);
      resolvedTargetId = targetId;
    }
    const topic = await feedbacks.createTopic({ id: `topic_${crypto.randomUUID()}`, targetType, targetId: resolvedTargetId, name: name.trim(), createdBy });
    return sendJson(response, 201, topic);
  } catch (error) { return next(error); }
});
app.post('/api/topics/:topicId/read', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  try {
    const { viewerId } = await resolveViewerForRead(request.auth);
    if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    // Not privilege-bypassed: an admin browsing a topic via Employee Wall
    // oversight must not silently mark it read for themselves.
    if (!await feedbacks.canViewTopic({ topicId: request.params.topicId, viewerId, viewerIsPrivileged: false })) {
      return sendError(response, request, 403, 'FORBIDDEN', 'You do not have access to this topic.');
    }
    await feedbacks.markTopicRead({ topicId: request.params.topicId, userId: viewerId });
    return response.status(204).end();
  } catch (error) { return next(error); }
});
app.post('/api/topics/:topicId/typing', async (request, response, next) => {
  try {
    const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
    if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    if (!await feedbacks.canViewTopic({ topicId: request.params.topicId, viewerId, viewerIsPrivileged: isPrivileged })) {
      return sendError(response, request, 403, 'FORBIDDEN', 'You do not have access to this topic.');
    }
    await feedbacks.setTyping({ topicId: request.params.topicId, userId: viewerId });
    return response.status(204).end();
  } catch (error) { return next(error); }
});

const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
// Only these render inline; everything else (including SVG and HTML, which
// can carry script) is served as a download, never interpreted by the browser.
const INLINE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/ogg']);

// Raw body, not JSON/base64 — the client always sends application/octet-stream
// (so the global express.json never touches it) with the real name/type in
// headers.
app.post('/api/attachments', express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES }), async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  const data = request.body;
  if (!Buffer.isBuffer(data) || !data.length) return sendError(response, request, 422, 'VALIDATION_ERROR', 'The request body must be the file.');
  let filename = 'file';
  try { filename = decodeURIComponent(String(request.headers['x-filename'] || 'file')); } catch { /* keep default */ }
  filename = filename.replace(/[\r\n"\\/]/g, '_').slice(0, 255) || 'file';
  const suppliedType = String(request.headers['x-file-type'] || '').toLowerCase();
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(suppliedType) && suppliedType.length <= 120 ? suppliedType : 'application/octet-stream';
  try {
    const uploaderId = await feedbacks.resolveIdentityAccount({ sub: auth.sub, email: auth.email, name: auth.name, role: auth.role });
    return sendJson(response, 201, await feedbacks.createAttachment({ id: `att_${crypto.randomUUID()}`, uploaderId, filename, mimeType, data }));
  } catch (error) { return next(error); }
});

app.get('/api/attachments/:attachmentId', async (request, response, next) => {
  try {
    const attachment = await feedbacks.getAttachment(request.params.attachmentId);
    if (!attachment) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No attachment with that id.');
    if (attachment.feedbackId) {
      // Same rule as the message it's attached to.
      if (!await loadAccessibleFeedback(request, response, attachment.feedbackId)) return;
    } else {
      // Uploaded but not sent yet: only its uploader.
      const { viewerId } = await resolveViewerForRead(request.auth);
      if (viewerId !== attachment.uploaderId) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No attachment with that id.');
    }
    const inline = INLINE_MEDIA_TYPES.has(attachment.mimeType);
    afterLiveCheck(response, () => {
      response.set({
        'content-type': inline ? attachment.mimeType : 'application/octet-stream',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=86400',
        'accept-ranges': 'bytes'
      });
      // Byte ranges, so a video can be seeked (browsers won't otherwise).
      const data = attachment.data;
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (start >= data.length || start > end) {
          response.status(416).set('content-range', `bytes */${data.length}`).end();
          return;
        }
        response.status(206).set('content-range', `bytes ${start}-${end}/${data.length}`).send(data.subarray(start, end + 1));
        return;
      }
      response.send(data);
    });
  } catch (error) { return next(error); }
});

app.delete('/api/topics/:topicId', async (request, response, next) => {
  const auth = request.auth || {};
  if (!auth.sub) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
  try {
    const { viewerId, isPrivileged } = await resolveViewerForRead(request.auth);
    if (!viewerId) return sendError(response, request, 401, 'UNAUTHORIZED', 'This endpoint needs a signed-in session.');
    const topic = await feedbacks.getTopicById(request.params.topicId);
    if (!topic) return sendError(response, request, 404, 'RESOURCE_NOT_FOUND', 'No topic with that id.');
    // A group's own owner/sub-admins delete any of its topics (company
    // admins/managers don't manage groups); elsewhere admins/managers do.
    const canDeleteAny = topic.targetType === 'group' ? await isGroupManager(topic.targetId, viewerId) : isPrivileged;
    if (!canDeleteAny) {
      if (!await feedbacks.canViewTopic({ topicId: request.params.topicId, viewerId, viewerIsPrivileged: false })) {
        return sendError(response, request, 403, 'FORBIDDEN', 'You do not have access to this topic.');
      }
      // Admins/managers can delete any topic; everyone else only an empty one.
      if (await feedbacks.countTopicMessages(request.params.topicId) > 0) {
        return sendError(response, request, 403, 'FORBIDDEN', 'Only an empty topic can be deleted. Ask an admin to remove one with messages.');
      }
    }
    await feedbacks.deleteTopic(request.params.topicId);
    return response.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/logout', (_request, response) => {
  clearSession(response);
  return response.status(204).end();
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
  if (error.type === 'entity.too.large') {
    return sendError(response, request, 413, 'PAYLOAD_TOO_LARGE', 'That file is too large (3 MB max).');
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