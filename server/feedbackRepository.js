import { pool } from './database.js';

// SS-13: this table is a local, read-only-by-sync cache of identity data
// pulled from the main directory service's API (see internApi.js). It is
// never written to directly by end users — only upsertInternUsers() writes
// to it, and only from data the intern-database service's API returned.
export async function upsertInternUsers(interns) {
  if (!interns.length) return;
  // One multi-row statement instead of one round trip per intern — against a
  // remote VPS database, N sequential INSERTs is N network round trips, and
  // that (not the intern-database call) was most of the sync latency.
  const rowParams = [];
  const rowPlaceholders = interns.map(intern => {
    rowParams.push(
      `intern_${intern.externalId}`.slice(0, 50), intern.externalId, intern.name, intern.email,
      intern.role, intern.department, intern.avatar, JSON.stringify(intern.skills)
    );
    return `(?, ?, ?, ?, ?, ?, ?, ?, 'intern-api', CURRENT_TIMESTAMP)`;
  });
  await pool.query(
    `INSERT INTO users (id, external_id, name, email, role_title, department, avatar, skills, source, synced_at)
     VALUES ${rowPlaceholders.join(', ')}
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), email = VALUES(email), role_title = VALUES(role_title),
       department = VALUES(department), avatar = VALUES(avatar), skills = VALUES(skills),
       source = 'intern-api', synced_at = CURRENT_TIMESTAMP`,
    rowParams
  );
}

// Backs the sync TTL in rizurfApi.js: whether the directory was synced
// recently. Read from the database rather than process memory so the cache
// survives a serverless cold start (a fresh instance has no in-memory state,
// but the last sync is still recorded here) — and compare entirely in
// MySQL's own clock (`NOW()` vs `synced_at`, both written by the same
// server) rather than against Node's `Date.now()`, since the two clocks are
// not guaranteed to agree (the VPS's is measurably off from real time).
export async function isInternSyncFresh(ttlSeconds) {
  const [rows] = await pool.query(
    `SELECT (MAX(synced_at) IS NOT NULL AND MAX(synced_at) > (NOW() - INTERVAL ? SECOND)) AS isFresh
     FROM users WHERE source = 'intern-api'`,
    [ttlSeconds]
  );
  return Boolean(rows[0]?.isFresh);
}

// A person who signs in through the gateway (MICROAPP_AUTH.md sections 4 and
// 11) is provisioned here as a local account, so their feedback, comments,
// and private remarks have a stable owner row to reference. The row id is
// derived from the gateway `sub` so re-logins update the same record.
// `role_title` carries the gateway role (admin / hr / supervisor / user).
// `department` is not part of the identity token, so it is left as-is on
// update — an intern sync or an admin may have set it.
export async function upsertGatewayUser({ sub, email, name, role }) {
  if (!sub) throw new Error('Gateway identity is missing sub.');
  const localId = `gw_${sub}`.slice(0, 50);
  await pool.execute(
    `INSERT INTO users (id, external_id, name, email, role_title, permission_role, source, synced_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, 'user'), 'gateway', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), email = VALUES(email), role_title = VALUES(role_title),
       permission_role = COALESCE(?, permission_role),
       source = 'gateway', synced_at = CURRENT_TIMESTAMP`,
    [localId, String(sub), name || email || `User ${sub}`, email || null, role || null, role || null, role || null]
  );
  return localId;
}

// Resolve the local account id for a signed-in gateway identity. The person
// is identified by email, which is stable across sign-ins and shared with the
// intern directory. If a row with that email already exists — synced from the
// intern directory, or provisioned on an earlier sign-in — reuse it instead
// of minting a second `gw_<sub>` row (which is what produced duplicate
// accounts). A `gw_<sub>` row is created only when the email is new here.
// Read-only counterpart of resolveIdentityAccount: the canonical account id
// for an email, or null. Used on hot read paths (the feedback poll) that must
// not write on every call.
export async function findAccountIdByEmail(email) {
  if (!email) return null;
  const [rows] = await pool.execute(
    `SELECT id FROM users WHERE email = ?
     ORDER BY (source = 'intern-api') DESC, synced_at DESC, id ASC LIMIT 1`,
    [email]
  );
  return rows[0]?.id || null;
}

// This runs on every authenticated write (send a message, create a topic,
// add a group member, ...), so it's a hot path against a remote database —
// keep it to one read, and at most one write only when something actually
// changed, instead of two unconditional UPDATEs every single call.
export async function resolveIdentityAccount({ sub, email, name, role }) {
  if (email) {
    const [rows] = await pool.execute(
      `SELECT id, name, permission_role AS permissionRole FROM users WHERE email = ?
       ORDER BY (source = 'intern-api') DESC, synced_at DESC, id ASC
       LIMIT 1`,
      [email]
    );
    if (rows[0]) {
      const sets = [];
      const params = [];
      if (name && (rows[0].name === null || rows[0].name === '' || rows[0].name === `User ${sub}`)) {
        sets.push('name = ?');
        params.push(name);
      }
      // Resync the gateway's permission claim, independent of role_title (a
      // job title for intern-directory rows) — but only when it actually
      // changed, not on every request.
      if (role && role !== rows[0].permissionRole) {
        sets.push('permission_role = ?');
        params.push(role);
      }
      if (sets.length) {
        params.push(rows[0].id);
        await pool.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
      }
      return rows[0].id;
    }
  }
  return upsertGatewayUser({ sub, email, name, role });
}

// The gateway identity token carries no photo (MICROAPP_AUTH.md section 2:
// sub / email / name / role only), so a freshly provisioned gateway account
// has no avatar or department. The same person is usually also in the synced
// intern directory, which does. Fill the gateway row's still-empty identity
// fields from the newest directory row that shares its email.
export async function backfillGatewayProfileFromDirectory(id, email) {
  if (!id || !email) return;
  const [rows] = await pool.execute(
    `SELECT avatar, department FROM users
     WHERE email = ? AND source = 'intern-api' AND id <> ?
     ORDER BY synced_at DESC LIMIT 1`,
    [email, id]
  );
  const source = rows[0];
  if (!source) return;
  await pool.execute(
    `UPDATE users SET
       avatar = COALESCE(avatar, ?),
       department = CASE WHEN department IS NULL OR department = '' OR department = 'General' THEN ? ELSE department END
     WHERE id = ?`,
    [source.avatar || null, source.department || 'General', id]
  );
}

export async function getUserById(id) {
  const [rows] = await pool.execute(
    `SELECT id, external_id AS externalId, name, email, role_title AS role, permission_role AS permissionRole,
       department, avatar, skills, source
     FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return { ...rows[0], skills: rows[0].skills ? JSON.parse(rows[0].skills) : [] };
}

export async function listEmployees({ limit, offset }) {
  const [rows] = await pool.execute(
    'SELECT id, name, role_title AS role, department, avatar, skills FROM users ORDER BY name LIMIT ? OFFSET ?',
    [limit, offset]
  );
  return rows;
}

export async function listSyncedInterns({ limit, offset }) {
  const [rows] = await pool.execute(
    `SELECT id, external_id AS externalId, name, email, role_title AS role, department, avatar, skills, synced_at AS syncedAt
     FROM users WHERE source = 'intern-api' ORDER BY name LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows;
}

// Shared predicate for "may this viewer see this private row" — used to
// build the WHERE clause for listing private feedback/topics and, per-row,
// to retrofit access control onto the per-id comment/reaction routes (which
// today only check existence, not access). A privileged viewer (admin/
// manager) always passes — that's the whole of "admins and managers can
// view everything" from Employee Wall, no separate oversight query needed.
// Otherwise the viewer must own the row (`ownerColumn` — `sender_id` for a
// feedback row, `created_by` for a topic), be the target of a DM or their
// own Organization thread ('user'/'org' target types share the same
// "target_id is a user id" shape), or a member of the target group.
// Parametrized by table alias + owner column so `feedback` and `topics` can
// share one definition instead of drifting apart.
function accessSql(alias, ownerColumn) {
  return `(
    ? OR ${alias}.${ownerColumn} = ?
    OR (${alias}.target_type IN ('user','org') AND ${alias}.target_id = ?)
    OR (${alias}.target_type = 'group' AND ${alias}.target_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
  )`;
}
function accessParams(viewerIsPrivileged, viewerId) {
  return [Boolean(viewerIsPrivileged), viewerId || '', viewerId || '', viewerId || ''];
}
const PRIVATE_ACCESS_SQL = accessSql('f', 'sender_id');
const privateAccessParams = accessParams;
const TOPIC_ACCESS_SQL = accessSql('t', 'created_by');

export async function listFeedback({ targetId, senderId, participantId, topicId, limit, offset, visibility = 'public', viewerId, viewerIsPrivileged }) {
  const conditions = [];
  const parameters = [];
  if (visibility === 'private') {
    conditions.push('f.visibility = \'private\'', PRIVATE_ACCESS_SQL);
    parameters.push(...privateAccessParams(viewerIsPrivileged, viewerId));
    if (participantId) {
      conditions.push('f.target_type = \'user\' AND (f.sender_id = ? OR f.target_id = ?)');
      parameters.push(participantId, participantId);
    }
    if (topicId) { conditions.push('f.topic_id = ?'); parameters.push(topicId); }
  } else {
    conditions.push('f.visibility = \'public\'');
  }
  if (targetId) { conditions.push('f.target_id = ?'); parameters.push(targetId); }
  if (senderId) { conditions.push('f.sender_id = ?'); parameters.push(senderId); }
  parameters.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT f.id, f.sender_id AS senderId, u.name AS senderName, u.avatar AS senderAvatar, f.target_id AS targetId,
       f.target_type AS targetType, f.visibility, f.topic_id AS topicId, tp.name AS topicName,
       CASE
         WHEN f.target_id = 'company' THEN f.target_name
         WHEN f.target_type = 'org' THEN 'Organization'
         ELSE COALESCE(target_user.name, f.target_name)
       END AS targetName,
       f.content, f.is_anonymous AS isAnonymous, f.is_edited AS isEdited, f.created_at AS timestamp
     FROM feedback f
     JOIN users u ON u.id = f.sender_id
     LEFT JOIN users target_user ON target_user.id = f.target_id
     LEFT JOIN topics tp ON tp.id = f.topic_id
     ${where}
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    parameters
  );
  return rows;
}

export async function createFeedback({ id, senderId, targetId, targetName, content, isAnonymous, visibility = 'public', targetType = 'user', topicId = null }) {
  await pool.execute(
    'INSERT INTO feedback (id, sender_id, target_id, target_name, content, is_anonymous, visibility, target_type, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, senderId, targetId, targetName, content, isAnonymous, visibility, targetType, topicId]
  );
  const [rows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
  return rows[0];
}

export async function feedbackExists(id) {
  const [rows] = await pool.execute('SELECT 1 FROM feedback WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

// Existence + the fields needed to decide access/trust for the per-id
// comment and reaction routes, in one query.
export async function getFeedbackMeta(id) {
  const [rows] = await pool.execute(
    `SELECT id, visibility, target_type AS targetType, target_id AS targetId, sender_id AS senderId
     FROM feedback WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// Retrofit for the per-id comment/reaction routes, which historically only
// checked feedbackExists — with private rows sharing this table, an
// unguessable-but-known feedback id would otherwise bypass every privacy
// rule above. Mirrors PRIVATE_ACCESS_SQL for exactly one row.
export async function canViewFeedback({ feedbackId, viewerId, viewerIsPrivileged }) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM feedback f
     WHERE f.id = ? AND (f.visibility = 'public' OR ${PRIVATE_ACCESS_SQL})
     LIMIT 1`,
    [feedbackId, ...privateAccessParams(viewerIsPrivileged, viewerId)]
  );
  return rows.length > 0;
}

export async function listComments({ feedbackId, limit, offset }) {
  const [rows] = await pool.execute(
    `SELECT c.id, c.parent_id AS parentId, c.sender_id AS senderId, u.name AS senderName, u.avatar AS senderAvatar,
       c.content AS text, c.is_anonymous AS isAnonymous, c.is_edited AS isEdited, c.created_at AS timestamp
     FROM comments c
     JOIN users u ON u.id = c.sender_id
     WHERE c.feedback_id = ?
     ORDER BY c.created_at ASC LIMIT ? OFFSET ?`,
    [feedbackId, limit, offset]
  );
  return rows;
}

// All comments for a set of feedback ids, in one query, oldest first — used
// to attach threads to the feedback list so the UI can render them without
// a request per card.
export async function listCommentsForFeedback(feedbackIds) {
  if (!feedbackIds.length) return [];
  const placeholders = feedbackIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT c.id, c.feedback_id AS feedbackId, c.parent_id AS parentId, c.sender_id AS senderId,
       COALESCE(u.name, 'Unknown') AS senderName, u.avatar AS senderAvatar,
       c.content AS text, c.is_anonymous AS isAnonymous, c.is_edited AS isEdited, c.created_at AS timestamp
     FROM comments c
     LEFT JOIN users u ON u.id = c.sender_id
     WHERE c.feedback_id IN (${placeholders})
     ORDER BY c.created_at ASC`,
    feedbackIds
  );
  return rows;
}

export async function commentExists(id, feedbackId) {
  const [rows] = await pool.execute('SELECT 1 FROM comments WHERE id = ? AND feedback_id = ? LIMIT 1', [id, feedbackId]);
  return rows.length > 0;
}

// Toggle one emoji reaction by one user on a feedback item (commentId = '')
// or on one of its comments. Returns whether the reaction is now set.
export async function toggleReaction({ userId, feedbackId, commentId = '', reaction }) {
  const [existing] = await pool.execute(
    'SELECT 1 FROM reactions WHERE user_id = ? AND feedback_id = ? AND comment_id = ? AND reaction = ? LIMIT 1',
    [userId, feedbackId, commentId, reaction]
  );
  if (existing.length) {
    await pool.execute(
      'DELETE FROM reactions WHERE user_id = ? AND feedback_id = ? AND comment_id = ? AND reaction = ?',
      [userId, feedbackId, commentId, reaction]
    );
    return { reacted: false };
  }
  await pool.execute(
    'INSERT INTO reactions (user_id, feedback_id, comment_id, reaction) VALUES (?, ?, ?, ?)',
    [userId, feedbackId, commentId, reaction]
  );
  return { reacted: true };
}

// Reaction tallies for a set of feedback ids, feedback-level and per-comment,
// plus which ones the viewer has set.
export async function listReactionsForFeedback(feedbackIds, viewerId) {
  if (!feedbackIds.length) return [];
  const placeholders = feedbackIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT feedback_id AS feedbackId, comment_id AS commentId, reaction,
            COUNT(*) AS count,
            MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
     FROM reactions
     WHERE feedback_id IN (${placeholders})
     GROUP BY feedback_id, comment_id, reaction`,
    [viewerId || '', ...feedbackIds]
  );
  return rows;
}

export async function createComment({ id, feedbackId, parentId, senderId, text, isAnonymous }) {
  await pool.execute(
    'INSERT INTO comments (id, feedback_id, parent_id, sender_id, content, is_anonymous) VALUES (?, ?, ?, ?, ?, ?)',
    [id, feedbackId, parentId, senderId, text, isAnonymous]
  );
  return { id, feedbackId, parentId, senderId, text };
}

export async function listPrivateRemarks({ authorId, limit, offset }) {
  const [rows] = await pool.execute(
    `SELECT id, author_id AS authorId, target_id AS targetId, content, created_at AS createdAt
     FROM private_remarks WHERE author_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    [authorId, limit, offset]
  );
  return rows;
}

export async function createPrivateRemark({ id, authorId, targetId, content }) {
  await pool.execute(
    'INSERT INTO private_remarks (id, author_id, target_id, content) VALUES (?, ?, ?, ?)',
    [id, authorId, targetId, content]
  );
  const [rows] = await pool.execute(
    `SELECT id, author_id AS authorId, target_id AS targetId, content, created_at AS createdAt FROM private_remarks WHERE id = ?`,
    [id]
  );
  return rows[0];
}

export async function deletePrivateRemark({ id, authorId }) {
  const [result] = await pool.execute('DELETE FROM private_remarks WHERE id = ? AND author_id = ?', [id, authorId]);
  return result.affectedRows > 0;
}

// Project groups for the Feedbacks tab. Membership is intentionally open —
// any signed-in employee may create a group or add any existing user to any
// existing group (a product decision, not an oversight): see rizurfApi.js.
// `parentGroupId` makes this a sub-group (one level only — e.g. "ERP System"
// -> "Frontend"); a sub-group is a fully independent, postable group with
// its own membership, not a view onto its parent's.
export async function createGroup({ id, name, createdBy, parentGroupId = null }) {
  await pool.execute(
    'INSERT INTO feedback_groups (id, name, created_by, parent_group_id) VALUES (?, ?, ?, ?)',
    [id, name, createdBy, parentGroupId]
  );
  await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?)', [id, createdBy, createdBy]);
  const [rows] = await pool.execute(
    `SELECT id, name, created_by AS createdBy, parent_group_id AS parentGroupId, created_at AS createdAt
     FROM feedback_groups WHERE id = ?`, [id]
  );
  return rows[0];
}

export async function getGroupById(id) {
  const [rows] = await pool.execute(
    `SELECT id, name, created_by AS createdBy, parent_group_id AS parentGroupId, created_at AS createdAt
     FROM feedback_groups WHERE id = ? LIMIT 1`, [id]
  );
  return rows[0] || null;
}

export async function isGroupMember(groupId, userId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [groupId, userId]
  );
  return rows.length > 0;
}

export async function addGroupMember({ groupId, userId, addedBy }) {
  await pool.execute(
    'INSERT IGNORE INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?)', [groupId, userId, addedBy]
  );
}

// `mine` (a viewer id) restricts to groups that viewer belongs to, for the
// Feedbacks tab's sidebar; omitted, this is an open directory for
// discovery — the same "fully open" shape /api/employees already has.
// `parentId` (including the sentinel 'root') restricts to a specific
// parent's sub-groups, or to top-level groups only.
export async function listGroups({ mine, parentId, limit, offset }) {
  const conditions = [];
  const parameters = [];
  let join = '';
  if (mine) { join = 'JOIN group_members gm ON gm.group_id = g.id'; conditions.push('gm.user_id = ?'); parameters.push(mine); }
  if (parentId === 'root') conditions.push('g.parent_group_id IS NULL');
  else if (parentId) { conditions.push('g.parent_group_id = ?'); parameters.push(parentId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  parameters.push(limit, offset);
  const [rows] = await pool.execute(
    `SELECT g.id, g.name, g.created_by AS createdBy, g.parent_group_id AS parentGroupId, g.created_at AS createdAt,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS memberCount,
       (SELECT COUNT(*) FROM feedback_groups WHERE parent_group_id = g.id) AS subgroupCount
     FROM feedback_groups g ${join} ${where}
     ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
    parameters
  );
  return rows;
}

export async function listGroupMembers(groupId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.avatar FROM group_members gm
     JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.name`,
    [groupId]
  );
  return rows;
}

// ==========================================================================
// Topics — every private conversation (a DM, a group, or an employee's own
// Organization thread) is topic-based: multiple named topics can run side
// by side within the same container, each holding its own flat message
// list (no comment-nesting — that stays exclusive to the public wall).
// ==========================================================================

export async function getTopicById(id) {
  const [rows] = await pool.execute(
    `SELECT id, target_type AS targetType, target_id AS targetId, name, created_by AS createdBy, created_at AS createdAt
     FROM topics WHERE id = ? LIMIT 1`, [id]
  );
  return rows[0] || null;
}

export async function canViewTopic({ topicId, viewerId, viewerIsPrivileged }) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM topics t WHERE t.id = ? AND ${TOPIC_ACCESS_SQL} LIMIT 1`,
    [topicId, ...accessParams(viewerIsPrivileged, viewerId)]
  );
  return rows.length > 0;
}

export async function createTopic({ id, targetType, targetId, name, createdBy }) {
  await pool.execute(
    'INSERT INTO topics (id, target_type, target_id, name, created_by) VALUES (?, ?, ?, ?, ?)',
    [id, targetType, targetId, name, createdBy]
  );
  return getTopicById(id);
}

// Topics within one specific container, from `viewerId`'s point of view.
// 'user' containers are directional per row (a DM topic's `target_id` is
// "the other person" from ITS OWN creator's perspective), so matching "the
// topics between me and this counterpart" needs both orderings; 'group' and
// 'org' containers use a group/employee id directly, unambiguous either way.
export async function listTopicsInContainer({ targetType, targetId, viewerId, search, limit, offset }) {
  const conditions = ['t.target_type = ?'];
  const parameters = [targetType];
  if (targetType === 'user') {
    conditions.push('((t.created_by = ? AND t.target_id = ?) OR (t.created_by = ? AND t.target_id = ?))');
    parameters.push(viewerId, targetId, targetId, viewerId);
  } else {
    conditions.push('t.target_id = ?');
    parameters.push(targetId);
  }
  if (search) { conditions.push('t.name LIKE ?'); parameters.push(`%${search}%`); }
  parameters.push(limit, offset);
  const [rows] = await pool.execute(
    `SELECT t.id, t.target_type AS targetType, t.target_id AS targetId, t.name, t.created_by AS createdBy, t.created_at AS createdAt,
       (SELECT MAX(created_at) FROM feedback WHERE topic_id = t.id) AS lastMessageAt,
       (SELECT content FROM feedback WHERE topic_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastMessagePreview
     FROM topics t
     WHERE ${conditions.join(' AND ')}
     ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, t.created_at DESC
     LIMIT ? OFFSET ?`,
    parameters
  );
  return rows;
}

// Every topic `viewerId` can see across every DM/group/org they participate
// in — the whole basis of the Feedbacks tab (grouped into sections
// client-side) and of the unread nav badge (client sums `unreadCount`).
// `viewerIsPrivileged` is expected to be forced false by the caller for a
// user's own inbox — privileged bypass is only for the Employee Wall
// oversight lookup, never blended into someone's personal inbox.
export async function listMyTopics({ viewerId, viewerIsPrivileged }) {
  const [rows] = await pool.execute(
    `SELECT t.id, t.target_type AS targetType, t.target_id AS targetId, t.name, t.created_by AS createdBy, t.created_at AS createdAt,
       g.name AS groupName, org_user.name AS orgUserName,
       (SELECT MAX(created_at) FROM feedback WHERE topic_id = t.id) AS lastMessageAt,
       (SELECT content FROM feedback WHERE topic_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastMessagePreview,
       (SELECT COUNT(*) FROM feedback f2
          WHERE f2.topic_id = t.id AND f2.sender_id <> ?
            AND f2.created_at > COALESCE((SELECT last_read_at FROM topic_reads WHERE topic_id = t.id AND user_id = ?), '1970-01-02')
       ) AS unreadCount
     FROM topics t
     LEFT JOIN feedback_groups g ON t.target_type = 'group' AND g.id = t.target_id
     LEFT JOIN users org_user ON t.target_type = 'org' AND org_user.id = t.target_id
     WHERE ${TOPIC_ACCESS_SQL}
     ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, t.created_at DESC`,
    [viewerId || '', viewerId || '', ...accessParams(viewerIsPrivileged, viewerId)]
  );
  return rows;
}

export async function markTopicRead({ topicId, userId }) {
  await pool.execute(
    `INSERT INTO topic_reads (topic_id, user_id, last_read_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE last_read_at = CURRENT_TIMESTAMP`,
    [topicId, userId]
  );
}