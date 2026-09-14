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

export async function resolveIdentityAccount({ sub, email, name, role }) {
  if (email) {
    const [rows] = await pool.execute(
      `SELECT id FROM users WHERE email = ?
       ORDER BY (source = 'intern-api') DESC, synced_at DESC, id ASC
       LIMIT 1`,
      [email]
    );
    if (rows[0]) {
      if (name) {
        await pool.execute(
          'UPDATE users SET name = ? WHERE id = ? AND (name IS NULL OR name = ? OR name = ?)',
          [name, rows[0].id, '', `User ${sub}`]
        );
      }
      // Always resync the gateway's permission claim, independent of
      // role_title (a job title for intern-directory rows). Without this,
      // reusing an existing directory-matched row (the common case) silently
      // discarded the gateway's real admin/hr/supervisor/user standing on
      // every sign-in after the account's first.
      if (role) {
        await pool.execute('UPDATE users SET permission_role = ? WHERE id = ?', [role, rows[0].id]);
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

// Shared predicate for "may this viewer see this private feedback row" —
// used both to build the WHERE clause for listing private feedback and,
// per-row, to retrofit access control onto the per-id comment/reaction
// routes (which today only check existence, not access). A privileged
// viewer (admin/manager) always passes — that's the whole of "admins and
// managers can view everything" from Employee Wall, no separate oversight
// query needed. Otherwise the viewer must be the sender, the target of a DM
// or their own Organization thread ('user'/'org' target types share the
// same "target_id is a user id" shape), or a member of the target group.
const PRIVATE_ACCESS_SQL = `(
  ? OR f.sender_id = ?
  OR (f.target_type IN ('user','org') AND f.target_id = ?)
  OR (f.target_type = 'group' AND f.target_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
)`;
function privateAccessParams(viewerIsPrivileged, viewerId) {
  return [Boolean(viewerIsPrivileged), viewerId || '', viewerId || '', viewerId || ''];
}

export async function listFeedback({ targetId, senderId, participantId, limit, offset, visibility = 'public', viewerId, viewerIsPrivileged }) {
  const conditions = [];
  const parameters = [];
  if (visibility === 'private') {
    conditions.push('f.visibility = \'private\'', PRIVATE_ACCESS_SQL);
    parameters.push(...privateAccessParams(viewerIsPrivileged, viewerId));
    if (participantId) {
      conditions.push('f.target_type = \'user\' AND (f.sender_id = ? OR f.target_id = ?)');
      parameters.push(participantId, participantId);
    }
  } else {
    conditions.push('f.visibility = \'public\'');
  }
  if (targetId) { conditions.push('f.target_id = ?'); parameters.push(targetId); }
  if (senderId) { conditions.push('f.sender_id = ?'); parameters.push(senderId); }
  parameters.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT f.id, f.sender_id AS senderId, u.name AS senderName, u.avatar AS senderAvatar, f.target_id AS targetId,
       f.target_type AS targetType, f.visibility,
       CASE
         WHEN f.target_id = 'company' THEN f.target_name
         WHEN f.target_type = 'org' THEN 'Organization'
         ELSE COALESCE(target_user.name, f.target_name)
       END AS targetName,
       f.content, f.is_anonymous AS isAnonymous, f.is_edited AS isEdited, f.created_at AS timestamp
     FROM feedback f
     JOIN users u ON u.id = f.sender_id
     LEFT JOIN users target_user ON target_user.id = f.target_id
     ${where}
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    parameters
  );
  return rows;
}

export async function createFeedback({ id, senderId, targetId, targetName, content, isAnonymous, visibility = 'public', targetType = 'user' }) {
  await pool.execute(
    'INSERT INTO feedback (id, sender_id, target_id, target_name, content, is_anonymous, visibility, target_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, senderId, targetId, targetName, content, isAnonymous, visibility, targetType]
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
export async function createGroup({ id, name, createdBy }) {
  await pool.execute('INSERT INTO feedback_groups (id, name, created_by) VALUES (?, ?, ?)', [id, name, createdBy]);
  await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?)', [id, createdBy, createdBy]);
  const [rows] = await pool.execute(
    `SELECT id, name, created_by AS createdBy, created_at AS createdAt FROM feedback_groups WHERE id = ?`, [id]
  );
  return rows[0];
}

export async function getGroupById(id) {
  const [rows] = await pool.execute(
    'SELECT id, name, created_by AS createdBy, created_at AS createdAt FROM feedback_groups WHERE id = ? LIMIT 1', [id]
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
export async function listGroups({ mine, limit, offset }) {
  const parameters = [];
  let join = '';
  let where = '';
  if (mine) { join = 'JOIN group_members gm ON gm.group_id = g.id'; where = 'WHERE gm.user_id = ?'; parameters.push(mine); }
  parameters.push(limit, offset);
  const [rows] = await pool.execute(
    `SELECT g.id, g.name, g.created_by AS createdBy, g.created_at AS createdAt,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS memberCount
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