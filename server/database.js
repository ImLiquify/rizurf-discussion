import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { config } from './config.js';

// Deterministic short id for a backfilled "General" topic — hashed rather
// than a raw concatenation of the real ids, which overflows the 60-char
// topic id column for long ids (e.g. intern_<uuid> is 43 chars; two of
// them plus the 'topic_user_..._general' scaffolding is well over 60 and
// silently truncates mid-id, which is fragile: two different backfilled
// topics could in principle collide on the same truncated prefix).
function backfillTopicId(targetType, key) {
  const hash = crypto.createHash('md5').update(key).digest('hex');
  return `topic_${targetType}_${hash}_general`;
}

// No Express imports: workers and command-line tasks may reuse this DAL.
//
// On Vercel each invocation may spin up its own process, so a large pool
// (fine for one long-lived server) can exhaust a small hosted MySQL plan's
// max_connections under concurrent invocations. Keep the limit small when
// VERCEL is set (MICROAPP_PERFORMANCE.md §6: 2–5), but above 1 so a route's
// Promise.all actually runs its queries in parallel; local dev keeps 10.
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: process.env.VERCEL ? 3 : 10,
  namedPlaceholders: true,
  ...(config.db.ssl ? { ssl: { rejectUnauthorized: true } } : {})
});

// Time-boxed so a hanging DB reports `degraded` instead of hanging /health.
export async function databaseIsHealthy(ms = 800) {
  let timer;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
    ]);
  } finally { clearTimeout(timer); }
  return true;
}

async function columnsOf(table) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

// One round trip for every table's columns instead of one query per table.
// Safe to include a table that doesn't exist yet (e.g. feedback_groups on a
// fresh install) — information_schema just returns no rows for it, so the
// caller's Set comes back empty and addMissingColumns below still adds
// every wanted column once CREATE TABLE IF NOT EXISTS has run.
//
// This matters more than it looks: on Vercel the pool is capped at a single
// connection (see below), so Promise.all across these queries would NOT run
// them concurrently in production — they'd still queue one at a time on
// that one connection. The only real way to cut cold-start latency here is
// fewer round trips outright, not parallelizing them.
async function columnsOfTables(tables) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
    [tables]
  );
  const byTable = new Map(tables.map(table => [table, new Set()]));
  for (const row of rows) byTable.get(row.TABLE_NAME)?.add(row.COLUMN_NAME);
  return byTable;
}

function addMissingColumns(table, wanted, existing) {
  const clauses = wanted.filter(([column]) => !existing.has(column)).map(([column, definition]) => `ADD COLUMN ${column} ${definition}`);
  // One ALTER TABLE with every needed column, not one ALTER per column —
  // matters on a fresh install or after skipping several versions at once.
  return clauses.length ? pool.query(`ALTER TABLE ${table} ${clauses.join(', ')}`) : Promise.resolve();
}

export async function ensureSchemaCompatibility() {
  // Idempotent migration path for a `users` table created from an older
  // schema.sql. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is MariaDB / MySQL
  // 8.0.29+ only — the VPS runs MySQL 5.7 — so check information_schema and
  // add just the missing columns.
  const columns = await columnsOfTables(['users', 'reactions', 'feedback', 'feedback_groups', 'group_members']);

  await addMissingColumns('users', [
    ['external_id', 'VARCHAR(120) NULL UNIQUE'],
    ['email', 'VARCHAR(255) NULL'],
    ['role_title', 'VARCHAR(120) NULL'],
    ['avatar', 'VARCHAR(500) NULL'],
    ['skills', 'TEXT NULL'],
    ['source', "VARCHAR(40) NOT NULL DEFAULT 'local'"],
    ['synced_at', 'TIMESTAMP NULL'],
    // The gateway's reliable admin/hr/supervisor/user claim. Kept separate
    // from `role_title`, which holds a job title (e.g. "Intern") for
    // intern-directory-sourced rows and must not be used for access control.
    ['permission_role', "VARCHAR(20) NOT NULL DEFAULT 'user'"],
    // Set when a directory-synced person is no longer in the directory (they
    // left). The row stays so their past messages keep an author; they just
    // drop out of every people list. Cleared again if they come back.
    ['removed_at', 'TIMESTAMP NULL'],
    // Presence: bumped by POST /api/presence while the app is open.
    ['last_seen_at', 'TIMESTAMP NULL']
  ], columns.get('users'));

  // `reactions` originally keyed on (user_id, feedback_id, reaction) — feedback
  // only. Add `comment_id` ('' = a reaction on the feedback itself, otherwise
  // the comment id) and widen the primary key so a comment can carry its own
  // reactions. NOT NULL DEFAULT '' because a primary-key column cannot be NULL.
  const reactionColumns = columns.get('reactions');
  if (reactionColumns.size && !reactionColumns.has('comment_id')) {
    await pool.query("ALTER TABLE reactions ADD COLUMN comment_id VARCHAR(60) NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE reactions DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, feedback_id, comment_id, reaction)');
  }

  // Emoji must compare byte-for-byte: under utf8mb4_general_ci, MySQL 5.7
  // treats every emoji outside the BMP (😂 😮 👍 👏 …) as the same character,
  // so one person's 😂 and 😮 collided — the second toggled the first off.
  const [[reactionColumn]] = await pool.query(
    `SELECT COLLATION_NAME AS collation FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reactions' AND COLUMN_NAME = 'reaction'`
  );
  if (reactionColumn && reactionColumn.collation !== 'utf8mb4_bin') {
    await pool.query('ALTER TABLE reactions MODIFY reaction VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL');
  }

  // Private feedback (DMs, project groups, the Organization channel) reuses
  // the existing `feedback`/`comments`/`reactions` machinery instead of a
  // parallel messaging schema. `visibility` keeps every pre-existing row (and
  // every future public wall post) flowing through the old unfiltered code
  // path for free via its default; `target_type` says how to interpret
  // `target_id` ('user' id, the existing 'company' sentinel, a
  // `feedback_groups` id, or 'org' for a private per-employee thread with
  // admins/managers, keyed by that employee's own user id). `topic_id` has
  // no FK to `topics` (added further below) — it's never enforced, so there
  // is no ordering requirement forcing it to wait until after that table
  // exists, and checking it here saves a second round trip back to
  // information_schema for the same `feedback` table.
  await addMissingColumns('feedback', [
    ['visibility', "VARCHAR(10) NOT NULL DEFAULT 'public'"],
    ['target_type', "VARCHAR(10) NOT NULL DEFAULT 'user'"],
    ['topic_id', 'VARCHAR(60) NULL'],
    ['attachment_id', 'VARCHAR(60) NULL'],
    // Chat actions: the message this one replies to (same topic), and a
    // pin shared by everyone in the conversation.
    ['reply_to_id', 'VARCHAR(60) NULL'],
    ['pinned_at', 'TIMESTAMP NULL'],
    ['pinned_by', 'VARCHAR(50) NULL'],
    // Pins expire: after this the message simply reads as unpinned.
    ['pinned_until', 'TIMESTAMP NULL']
  ], columns.get('feedback'));

  // Project groups. Named `feedback_groups`, not `groups` — GROUPS is a
  // reserved word in current MySQL/MariaDB (window-frame syntax) and an
  // unquoted `CREATE TABLE groups (...)` fails with a syntax error.
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback_groups (
    id varchar(50) NOT NULL,
    name varchar(160) NOT NULL,
    created_by varchar(50) NOT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (id),
    KEY idx_feedback_groups_created_by (created_by),
    CONSTRAINT fk_feedback_groups_created_by FOREIGN KEY (created_by) REFERENCES users (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS group_members (
    group_id varchar(50) NOT NULL,
    user_id varchar(50) NOT NULL,
    added_by varchar(50) DEFAULT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (group_id, user_id),
    KEY idx_group_members_user (user_id),
    CONSTRAINT fk_group_members_group FOREIGN KEY (group_id) REFERENCES feedback_groups (id) ON DELETE CASCADE,
    CONSTRAINT fk_group_members_user FOREIGN KEY (user_id) REFERENCES users (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // Legacy: 'admin' marked a sub-admin before group roles existed; it's
  // converted into a "Sub-admin" role further below and no longer read.
  await addMissingColumns('group_members', [
    ['role', "VARCHAR(10) NOT NULL DEFAULT 'member'"]
  ], columns.get('group_members'));

  // One level of sub-groups (e.g. "ERP System" -> "Frontend"/"Backend").
  // NULL means a top-level group. A sub-group is a fully independent,
  // postable group (its own row, own membership) — parent_group_id is only
  // for grouping them in the UI, not an access-control relationship.
  // `avatar` is an optional photo URL (no upload storage in this app, so
  // it's set the same way an employee's synced avatar already is: a URL),
  // shown in place of the generic group icon once set.
  await addMissingColumns('feedback_groups', [
    ['parent_group_id', 'VARCHAR(50) NULL'],
    ['avatar', 'VARCHAR(500) NULL']
  ], columns.get('feedback_groups'));

  // Topics: every private conversation (a DM, a group, or an employee's
  // Organization thread) is topic-based — multiple named topics can run
  // side by side within the same container, each with its own message
  // thread. `target_type`/`target_id` name the container the exact same way
  // `feedback.target_type`/`target_id` already do, so a topic's visibility
  // is governed by the identical access predicate as its container.
  await pool.query(`CREATE TABLE IF NOT EXISTS topics (
    id varchar(60) NOT NULL,
    target_type varchar(10) NOT NULL,
    target_id varchar(50) NOT NULL,
    name varchar(160) NOT NULL,
    created_by varchar(50) NOT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (id),
    KEY idx_topics_target (target_type, target_id),
    CONSTRAINT fk_topics_created_by FOREIGN KEY (created_by) REFERENCES users (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // Read markers, per topic per user — the basis for unread counts (the
  // Feedbacks nav badge and the per-conversation indicators). Absence of a
  // row means "never opened", i.e. everything in the topic is unread.
  await pool.query(`CREATE TABLE IF NOT EXISTS topic_reads (
    topic_id varchar(60) NOT NULL,
    user_id varchar(50) NOT NULL,
    last_read_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (topic_id, user_id),
    CONSTRAINT fk_topic_reads_topic FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
    CONSTRAINT fk_topic_reads_user FOREIGN KEY (user_id) REFERENCES users (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // Backfill: any private message sent before topics existed (topic_id
  // still NULL) gets folded into one "General" topic per container, so it
  // stays reachable instead of silently disappearing from the new
  // topic-scoped UI. A no-op on every boot after the first.
  //
  // 'group'/'org' rows: target_id is already a stable per-container key
  // (a group's own id, or — for org — the employee whose thread this is,
  // fixed regardless of sender), so grouping directly on it is correct.
  const [orphanedStable] = await pool.query(
    `SELECT DISTINCT target_type, target_id, sender_id FROM feedback
     WHERE visibility = 'private' AND target_type IN ('group', 'org') AND topic_id IS NULL`
  );
  for (const row of orphanedStable) {
    const topicId = backfillTopicId(row.target_type, row.target_id);
    await pool.query(
      `INSERT IGNORE INTO topics (id, target_type, target_id, name, created_by) VALUES (?, ?, ?, 'General', ?)`,
      [topicId, row.target_type, row.target_id, row.sender_id]
    );
    await pool.query(
      `UPDATE feedback SET topic_id = ? WHERE target_type = ? AND target_id = ? AND visibility = 'private' AND topic_id IS NULL`,
      [topicId, row.target_type, row.target_id]
    );
  }

  // 'user' (DM) rows: target_id is directional per row — "who THIS message
  // was sent to" — so a back-and-forth DM has messages with target_id
  // pointing both ways. Grouping on target_id directly would split one
  // conversation into two "General" topics; group on the unordered
  // {sender_id, target_id} pair instead.
  const [orphanedDms] = await pool.query(
    `SELECT DISTINCT LEAST(sender_id, target_id) AS a, GREATEST(sender_id, target_id) AS b FROM feedback
     WHERE visibility = 'private' AND target_type = 'user' AND topic_id IS NULL`
  );
  for (const { a, b } of orphanedDms) {
    const topicId = backfillTopicId('user', `${a}:${b}`);
    await pool.query(
      `INSERT IGNORE INTO topics (id, target_type, target_id, name, created_by) VALUES (?, 'user', ?, 'General', ?)`,
      [topicId, b, a]
    );
    await pool.query(
      `UPDATE feedback SET topic_id = ? WHERE visibility = 'private' AND target_type = 'user' AND topic_id IS NULL
         AND ((sender_id = ? AND target_id = ?) OR (sender_id = ? AND target_id = ?))`,
      [topicId, a, b, b, a]
    );
  }

  // DMs are one continuous thread per pair of people (no topics). Fold any
  // pair that still has several DM topics into its lowest-id one, then drop
  // the now-empty extras (topic_reads cascades). A no-op once merged.
  const dmPairs = `(SELECT LEAST(created_by, target_id) AS a, GREATEST(created_by, target_id) AS b, MIN(id) AS keep_id
    FROM topics WHERE target_type = 'user' GROUP BY a, b HAVING COUNT(*) > 1) k
    ON k.a = LEAST(t.created_by, t.target_id) AND k.b = GREATEST(t.created_by, t.target_id)`;
  await pool.query(`UPDATE feedback f JOIN topics t ON t.id = f.topic_id AND t.target_type = 'user' JOIN ${dmPairs}
    SET f.topic_id = k.keep_id WHERE f.topic_id <> k.keep_id`);
  await pool.query(`DELETE t FROM topics t JOIN ${dmPairs} WHERE t.target_type = 'user' AND t.id <> k.keep_id`);

  // Chat attachments live in the database (Vercel has no persistent disk).
  // Capped at 3 MB per file by the upload route — under both Vercel's 4.5 MB
  // request limit and MySQL 5.7's default 4 MB max_allowed_packet.
  await pool.query(`CREATE TABLE IF NOT EXISTS attachments (
    id varchar(60) NOT NULL,
    uploader_id varchar(50) NOT NULL,
    filename varchar(255) NOT NULL,
    mime_type varchar(120) NOT NULL,
    size int NOT NULL,
    data mediumblob NOT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (id),
    KEY idx_attachments_uploader (uploader_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // "X is typing…" — one heartbeat row per person per topic, refreshed while
  // they type and read back by the open-topic poll. Shared through the DB
  // because serverless instances don't share memory.
  await pool.query(`CREATE TABLE IF NOT EXISTS topic_typing (
    topic_id varchar(60) NOT NULL,
    user_id varchar(50) NOT NULL,
    updated_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (topic_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // "Delete for me": messages a person hid from their own view only.
  await pool.query(`CREATE TABLE IF NOT EXISTS message_hidden (
    user_id varchar(50) NOT NULL,
    feedback_id varchar(60) NOT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (user_id, feedback_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // Per-person starred messages (private to whoever starred them).
  await pool.query(`CREATE TABLE IF NOT EXISTS message_stars (
    user_id varchar(50) NOT NULL,
    feedback_id varchar(60) NOT NULL,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (user_id, feedback_id),
    KEY idx_message_stars_feedback (feedback_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // Discord-style group roles: the owner creates roles with permissions
  // (a comma list of GROUP_PERMISSIONS in rizurfApi.js) and assigns members.
  await pool.query(`CREATE TABLE IF NOT EXISTS group_roles (
    id varchar(60) NOT NULL,
    group_id varchar(50) NOT NULL,
    name varchar(60) NOT NULL,
    color varchar(7) NOT NULL DEFAULT '#039DB1',
    permissions varchar(255) NOT NULL DEFAULT '',
    position int NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (id),
    KEY idx_group_roles_group (group_id),
    CONSTRAINT fk_group_roles_group FOREIGN KEY (group_id) REFERENCES feedback_groups (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS group_member_roles (
    role_id varchar(60) NOT NULL,
    user_id varchar(50) NOT NULL,
    PRIMARY KEY (role_id, user_id),
    KEY idx_group_member_roles_user (user_id),
    CONSTRAINT fk_group_member_roles_role FOREIGN KEY (role_id) REFERENCES group_roles (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

  // One-time: the old per-member 'admin' flag (sub-admin) becomes a
  // "Sub-admin" role with every permission. A no-op once converted.
  const [legacyAdmins] = await pool.query("SELECT group_id, user_id FROM group_members WHERE role = 'admin'");
  for (const groupId of new Set(legacyAdmins.map(row => row.group_id))) {
    const roleId = `role_${crypto.createHash('md5').update(groupId).digest('hex')}_subadmin`;
    await pool.query(
      `INSERT IGNORE INTO group_roles (id, group_id, name, color, permissions) VALUES (?, ?, 'Sub-admin', '#039DB1', 'manage_group,manage_members,manage_messages')`,
      [roleId, groupId]
    );
    for (const row of legacyAdmins.filter(r => r.group_id === groupId)) {
      await pool.query('INSERT IGNORE INTO group_member_roles (role_id, user_id) VALUES (?, ?)', [roleId, row.user_id]);
    }
    await pool.query("UPDATE group_members SET role = 'member' WHERE group_id = ? AND role = 'admin'", [groupId]);
  }
}