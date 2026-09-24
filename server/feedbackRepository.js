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
// Read-only counterpart of resolveIdentityAccount, for hot read paths (the
// feedback poll) that must not write on every call: the canonical account
// and its permission role in one round trip. An email match wins (directory
// rows first), else the gateway-only `gw_<sub>` row.
export async function findViewerForRead(email, fallbackId) {
  const [rows] = await pool.execute(
    `SELECT id, permission_role AS permissionRole FROM users WHERE email = ? OR id = ?
     ORDER BY (email <=> ?) DESC, (source = 'intern-api') DESC, synced_at DESC, id ASC LIMIT 1`,
    [email ?? null, fallbackId ?? null, email ?? null]
  );
  return rows[0] || null;
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
  // `skills` is stored as a JSON-encoded string (see upsertInternUsers) —
  // decode it the same way getUserById does, or the frontend's
  // Array.isArray(e.skills) check always sees a string and silently treats
  // every employee as having no skills.
  return rows.map(row => ({ ...row, skills: row.skills ? JSON.parse(row.skills) : [] }));
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
//
// 'org' is a single shared company-wide channel (target_id = the
// ORG_SHARED_TARGET_ID sentinel in rizurfApi.js) — anyone signed in can read
// it, same as everyone being an implicit member. Older rows created before
// that change used a per-employee sentinel (target_id = that employee's own
// id, a private 1:1 thread with leadership) — those keep their original
// privacy: only that employee and a privileged viewer can still see them.
function accessSql(alias, ownerColumn) {
  return `(
    ? OR ${alias}.${ownerColumn} = ?
    OR (${alias}.target_type = 'user' AND ${alias}.target_id = ?)
    OR (${alias}.target_type = 'org' AND (${alias}.target_id = 'organization' OR ${alias}.target_id = ?))
    OR (${alias}.target_type = 'group' AND ${alias}.target_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
  )`;
}
function accessParams(viewerIsPrivileged, viewerId) {
  return [Boolean(viewerIsPrivileged), viewerId || '', viewerId || '', viewerId || '', viewerId || ''];
}
const PRIVATE_ACCESS_SQL = accessSql('f', 'sender_id');
const privateAccessParams = accessParams;
const TOPIC_ACCESS_SQL = accessSql('t', 'created_by');

export async function listFeedback({ targetId, senderId, participantId, groupMemberId, oversightFor, topicId, limit, offset, visibility = 'public', viewerId, viewerIsPrivileged }) {
  const conditions = [];
  const parameters = [];
  if (visibility === 'private') {
    conditions.push('f.visibility = \'private\'', PRIVATE_ACCESS_SQL);
    parameters.push(...privateAccessParams(viewerIsPrivileged, viewerId));
    if (participantId) {
      conditions.push('f.target_type = \'user\' AND (f.sender_id = ? OR f.target_id = ?)');
      parameters.push(participantId, participantId);
    }
    // Group messages in every group a given employee belongs to — target_id
    // on a group row is the group's own id, never that employee's id, so
    // this can't be expressed with the targetId/participantId filters above.
    if (groupMemberId) {
      conditions.push('f.target_type = \'group\' AND f.target_id IN (SELECT group_id FROM group_members WHERE user_id = ?)');
      parameters.push(groupMemberId);
    }
    // Employee Wall oversight: every DM, Organization message, and group
    // message involving one employee, in a single round trip — the OR of
    // what participantId + groupMemberId would each match separately, plus
    // this employee's own activity in the shared Organization channel
    // (sender_id — there's no "target" to key off any more since it's a
    // shared channel, not 1:1) or, for messages predating that change, their
    // old private per-employee org thread (target_id). Every request already
    // pays a live, uncachable gateway introspection check (see
    // MICROAPP_AUTH.md §5), so collapsing what used to be three separate
    // GETs into one cuts that fixed cost by two thirds.
    if (oversightFor) {
      conditions.push(`(
        (f.target_type = 'user' AND (f.sender_id = ? OR f.target_id = ?))
        OR (f.target_type = 'org' AND (f.sender_id = ? OR f.target_id = ?))
        OR (f.target_type = 'group' AND f.target_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
      )`);
      parameters.push(oversightFor, oversightFor, oversightFor, oversightFor, oversightFor);
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
       f.target_type AS targetType, f.visibility, f.topic_id AS topicId, tp.name AS topicName, tp.created_by AS topicCreatedBy,
       CASE
         WHEN f.target_id = 'company' THEN f.target_name
         WHEN f.target_type = 'org' THEN 'Organization'
         ELSE COALESCE(target_user.name, f.target_name)
       END AS targetName,
       f.content, f.is_anonymous AS isAnonymous, f.is_edited AS isEdited, f.created_at AS timestamp,
       f.attachment_id AS attachmentId, att.filename AS attachmentName, att.mime_type AS attachmentType, att.size AS attachmentSize
     FROM feedback f
     JOIN users u ON u.id = f.sender_id
     LEFT JOIN attachments att ON att.id = f.attachment_id
     LEFT JOIN users target_user ON target_user.id = f.target_id
     LEFT JOIN topics tp ON tp.id = f.topic_id
     ${where}
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    parameters
  );
  return rows;
}

// Given/received tallies across every feedback row (public wall + private
// DMs/groups/Organization) — the Employee Wall tile used to count only
// public rows, so an employee's private activity never moved the numbers.
// 'given' = rows they sent; 'received' = rows addressed directly to them
// (a DM, or a public post targeting them) — a group/org row's target_id is
// the group/sentinel, not a person, so a broadcast message doesn't count as
// "received by" any one individual, same as a public 'company' post
// already didn't. One aggregate query, not one per employee.
// A private conversation is counted per TOPIC, not per message — the topic
// is the feedback; the messages inside it are its comments/details. Whoever
// created a DM/group/org topic "gave" that one piece of feedback, no matter
// how many messages follow (a 40-message back-and-forth still counts once),
// and the other side of a DM "received" it. This used to count every
// individual message row instead: someone who mostly replies inside
// conversations other people started could rack up a large "given" number
// from replies alone, while a topic's own creator got no extra credit for
// starting it — the opposite of what "given/received" is supposed to mean.
// Group/org topics have no single recipient (many members, or the whole
// company), so they only ever count toward the creator's "given" — crediting
// them to some individual's "received" was the specific bug behind an org
// message showing up as something a person had "received". The public wall
// has no topic concept (every post already stands on its own), so it stays
// message-based, unchanged.
export async function getFeedbackCounts() {
  const [rows] = await pool.query(`
    SELECT id, kind, SUM(count) AS count FROM (
      SELECT sender_id AS id, 'given' AS kind, COUNT(*) AS count FROM feedback WHERE visibility = 'public' GROUP BY sender_id
      UNION ALL
      SELECT target_id AS id, 'received' AS kind, COUNT(*) AS count FROM feedback WHERE visibility = 'public' GROUP BY target_id
      UNION ALL
      SELECT created_by AS id, 'given' AS kind, COUNT(*) AS count FROM topics GROUP BY created_by
      UNION ALL
      SELECT target_id AS id, 'received' AS kind, COUNT(*) AS count FROM topics WHERE target_type = 'user' GROUP BY target_id
    ) counted
    GROUP BY id, kind
  `);
  const counts = {};
  for (const row of rows) {
    if (!counts[row.id]) counts[row.id] = { given: 0, received: 0 };
    counts[row.id][row.kind] = Number(row.count);
  }
  return counts;
}

export async function createFeedback({ id, senderId, targetId, targetName, content, isAnonymous, visibility = 'public', targetType = 'user', topicId = null, attachmentId = null }) {
  await pool.execute(
    'INSERT INTO feedback (id, sender_id, target_id, target_name, content, is_anonymous, visibility, target_type, topic_id, attachment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, senderId, targetId, targetName, content, isAnonymous, visibility, targetType, topicId, attachmentId]
  );
  const [rows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
  return rows[0];
}

export async function feedbackExists(id) {
  const [rows] = await pool.execute('SELECT 1 FROM feedback WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

export async function updateFeedbackContent({ id, content }) {
  await pool.execute('UPDATE feedback SET content = ?, is_edited = 1 WHERE id = ?', [content, id]);
  const [rows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
  return rows[0] || null;
}

// Comments/reactions on this feedback cascade via their own foreign keys.
export async function deleteFeedback(id) {
  const [result] = await pool.execute('DELETE FROM feedback WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// Existence + the fields needed to decide access/trust for the per-id
// comment and reaction routes, in one query.
export async function getFeedbackMeta(id) {
  const [rows] = await pool.execute(
    `SELECT id, visibility, target_type AS targetType, target_id AS targetId, sender_id AS senderId, created_at AS createdAt,
       TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ageSeconds
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

// Existence + owner, for the edit/delete comment routes' permission check.
export async function getCommentMeta(id, feedbackId) {
  const [rows] = await pool.execute(
    'SELECT id, feedback_id AS feedbackId, sender_id AS senderId FROM comments WHERE id = ? AND feedback_id = ? LIMIT 1',
    [id, feedbackId]
  );
  return rows[0] || null;
}

export async function updateCommentContent({ id, content }) {
  await pool.execute('UPDATE comments SET content = ?, is_edited = 1 WHERE id = ?', [content, id]);
  const [rows] = await pool.execute(
    `SELECT c.id, c.parent_id AS parentId, c.sender_id AS senderId, u.name AS senderName, u.avatar AS senderAvatar,
       c.content AS text, c.is_anonymous AS isAnonymous, c.is_edited AS isEdited, c.created_at AS timestamp
     FROM comments c JOIN users u ON u.id = c.sender_id WHERE c.id = ?`,
    [id]
  );
  return rows[0] || null;
}

// Reply comments cascade via comments.fk_comments_parent, however deep the
// thread goes. reactions.comment_id has no foreign key at all (it was added
// later via a plain ALTER TABLE — see ensureSchemaCompatibility in
// database.js), so it does not cascade — walk the same reply tree here and
// clean those up explicitly, or a deleted reply's reactions would linger as
// unreachable dead rows forever.
export async function deleteCommentById(id) {
  let level = [id];
  const allIds = [id];
  while (level.length) {
    const placeholders = level.map(() => '?').join(',');
    const [rows] = await pool.execute(`SELECT id FROM comments WHERE parent_id IN (${placeholders})`, level);
    level = rows.map(row => row.id);
    allIds.push(...level);
  }
  const idPlaceholders = allIds.map(() => '?').join(',');
  await pool.execute(`DELETE FROM reactions WHERE comment_id IN (${idPlaceholders})`, allIds);
  const [result] = await pool.execute('DELETE FROM comments WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// Project groups for the Feedbacks tab. Discord-style leadership: any
// signed-in employee may create a group (becoming its leader), but managing
// membership and settings afterward is restricted to that leader plus
// admins/managers — see the gating in rizurfApi.js. `parentGroupId` makes
// this a sub-group (one level only — e.g. "ERP System" -> "Frontend"); a
// sub-group is a fully independent, postable group with its own membership,
// not a view onto its parent's.
export async function createGroup({ id, name, createdBy, parentGroupId = null }) {
  await pool.execute(
    'INSERT INTO feedback_groups (id, name, created_by, parent_group_id) VALUES (?, ?, ?, ?)',
    [id, name, createdBy, parentGroupId]
  );
  await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?)', [id, createdBy, createdBy]);
  const [rows] = await pool.execute(
    `SELECT id, name, created_by AS createdBy, parent_group_id AS parentGroupId, avatar, created_at AS createdAt
     FROM feedback_groups WHERE id = ?`, [id]
  );
  return rows[0];
}

export async function getGroupById(id) {
  const [rows] = await pool.execute(
    `SELECT id, name, created_by AS createdBy, parent_group_id AS parentGroupId, avatar, created_at AS createdAt
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

export async function removeGroupMember({ groupId, userId }) {
  await pool.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

// `name` and/or `avatar` — whichever is provided (undefined means "leave
// as-is"); `avatar: null` explicitly clears a previously-set photo.
export async function updateGroup({ groupId, name, avatar }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (avatar !== undefined) { sets.push('avatar = ?'); params.push(avatar); }
  if (sets.length) {
    params.push(groupId);
    await pool.execute(`UPDATE feedback_groups SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getGroupById(groupId);
}

// Deletes the group row itself; group_members cascades via its own foreign
// key. Sub-groups do NOT — `parent_group_id` is a plain column added via
// addMissingColumns in database.js, with no foreign key (unlike the
// standalone schema.sql/migration file, which isn't what actually runs
// against the app's own database), so a parent's sub-groups would otherwise
// be silently orphaned (their own row survives with a parent_group_id that
// no longer resolves) — delete them explicitly first. One level is enough:
// creation already forbids a sub-group from having its own sub-groups (see
// the parentGroupId check in POST /api/groups). Historical feedback/topics
// that referenced any of these groups aren't cleaned up (target_id there is
// never FK-constrained, by design — see createFeedback) — they keep showing
// the group's name as it was stored at post time instead of pointing at a
// live group.
export async function deleteGroup(groupId) {
  await pool.execute('DELETE FROM feedback_groups WHERE parent_group_id = ?', [groupId]);
  const [result] = await pool.execute('DELETE FROM feedback_groups WHERE id = ?', [groupId]);
  return result.affectedRows > 0;
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
    `SELECT g.id, g.name, g.created_by AS createdBy, g.parent_group_id AS parentGroupId, g.avatar, g.created_at AS createdAt,
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

export async function countTopicMessages(topicId) {
  const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM feedback WHERE topic_id = ?', [topicId]);
  return rows[0].count;
}

// Deletes every message in the topic first — comments/reactions on them
// cascade via their own foreign keys to feedback.id — so an admin/manager
// force-deleting a non-empty topic actually clears its history instead of
// orphaning it; topic_reads cascades from the topics row itself.
export async function deleteTopic(topicId) {
  await pool.execute('DELETE FROM feedback WHERE topic_id = ?', [topicId]);
  const [result] = await pool.execute('DELETE FROM topics WHERE id = ?', [topicId]);
  return result.affectedRows > 0;
}

// Topics within one specific container, from `viewerId`'s point of view.
// 'user' containers are directional per row (a DM topic's `target_id` is
// "the other person" from ITS OWN creator's perspective), so matching "the
// topics between me and this counterpart" needs both orderings; 'group'
// containers use the group id directly, unambiguous either way.
export async function listTopicsInContainer({ targetType, targetId, viewerId, search, limit, offset }) {
  const conditions = ['t.target_type = ?'];
  const parameters = [targetType];
  if (targetType === 'user') {
    conditions.push('((t.created_by = ? AND t.target_id = ?) OR (t.created_by = ? AND t.target_id = ?))');
    parameters.push(viewerId, targetId, targetId, viewerId);
  } else if (targetType === 'org') {
    // The shared Organization channel (target_id = ORG_SHARED_TARGET_ID),
    // plus — for a viewer who still has one — their own topic from before
    // 'org' became shared (created under the old per-employee sentinel,
    // where target_id was always their own id, same as created_by).
    conditions.push('(t.target_id = ? OR t.created_by = ?)');
    parameters.push(targetId, viewerId);
  } else {
    conditions.push('t.target_id = ?');
    parameters.push(targetId);
  }
  if (search) { conditions.push('t.name LIKE ?'); parameters.push(`%${search}%`); }
  // unreadCount for viewerId, same definition listMyTopics uses — the topic
  // list rendered inside an open container reads this field too
  // (topicListItemHtml), so leaving it out here (as this query used to)
  // meant every per-topic unread dot inside a container silently never showed.
  const queryParams = [viewerId || '', viewerId || '', ...parameters, limit, offset];
  const [rows] = await pool.execute(
    `SELECT t.id, t.target_type AS targetType, t.target_id AS targetId, t.name, t.created_by AS createdBy, t.created_at AS createdAt,
       (SELECT MAX(created_at) FROM feedback WHERE topic_id = t.id) AS lastMessageAt,
       (SELECT content FROM feedback WHERE topic_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastMessagePreview,
       (SELECT COUNT(*) FROM feedback f2
          WHERE f2.topic_id = t.id AND f2.sender_id <> ?
            AND f2.created_at > COALESCE((SELECT last_read_at FROM topic_reads WHERE topic_id = t.id AND user_id = ?), '1970-01-02')
       ) AS unreadCount
     FROM topics t
     WHERE ${conditions.join(' AND ')}
     ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, t.created_at DESC
     LIMIT ? OFFSET ?`,
    queryParams
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

export async function createAttachment({ id, uploaderId, filename, mimeType, data }) {
  await pool.execute(
    'INSERT INTO attachments (id, uploader_id, filename, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?)',
    [id, uploaderId, filename, mimeType, data.length, data]
  );
  return { id, name: filename, type: mimeType, size: data.length };
}

// Everything needed to serve one attachment, plus the message it's attached
// to (null until sent) so the route can apply that message's access rule.
export async function getAttachment(id) {
  const [rows] = await pool.execute(
    `SELECT a.id, a.uploader_id AS uploaderId, a.filename, a.mime_type AS mimeType, a.data,
       (SELECT f.id FROM feedback f WHERE f.attachment_id = a.id LIMIT 1) AS feedbackId
     FROM attachments a WHERE a.id = ? LIMIT 1`, [id]
  );
  return rows[0] || null;
}

// Only the uploader may attach a file, and only to one message.
export async function getClaimableAttachment(id, uploaderId) {
  const [rows] = await pool.execute(
    `SELECT a.filename FROM attachments a
     WHERE a.id = ? AND a.uploader_id = ? AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.attachment_id = a.id) LIMIT 1`,
    [id, uploaderId]
  );
  return rows[0] || null;
}

export async function setTyping({ topicId, userId }) {
  await pool.execute(
    `INSERT INTO topic_typing (topic_id, user_id, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`, [topicId, userId]
  );
}

export async function clearTyping({ topicId, userId }) {
  await pool.execute('DELETE FROM topic_typing WHERE topic_id = ? AND user_id = ?', [topicId, userId]);
}

// Anyone but the viewer with a typing heartbeat in the last few seconds, in
// a topic the viewer can see — compared in MySQL's own clock, same reason as
// isInternSyncFresh.
export async function listTyping({ topicId, viewerId, viewerIsPrivileged }) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name FROM topic_typing tt
     JOIN users u ON u.id = tt.user_id
     JOIN topics t ON t.id = tt.topic_id AND ${TOPIC_ACCESS_SQL}
     WHERE tt.topic_id = ? AND tt.user_id <> ? AND tt.updated_at > NOW() - INTERVAL 6 SECOND`,
    [...accessParams(viewerIsPrivileged, viewerId), topicId, viewerId || '']
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