import mysql from 'mysql2/promise';
import { config } from './config.js';

// No Express imports: workers and command-line tasks may reuse this DAL.
//
// On Vercel each invocation may spin up its own process, so a large pool
// (fine for one long-lived server) can exhaust a small hosted MySQL plan's
// max_connections under concurrent invocations. Keep the limit small when
// VERCEL is set; local dev keeps the old default.
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: process.env.VERCEL ? 1 : 10,
  namedPlaceholders: true,
  ...(config.db.ssl ? { ssl: { rejectUnauthorized: true } } : {})
});

export async function databaseIsHealthy() {
  await pool.query('SELECT 1');
  return true;
}

async function columnsOf(table) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

async function addMissingColumns(table, wanted, existing) {
  for (const [column, definition] of wanted) {
    if (!existing.has(column)) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function ensureSchemaCompatibility() {
  // Idempotent migration path for a `users` table created from an older
  // schema.sql. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is MariaDB / MySQL
  // 8.0.29+ only — the VPS runs MySQL 5.7 — so check information_schema and
  // add just the missing columns.
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
    ['permission_role', "VARCHAR(20) NOT NULL DEFAULT 'user'"]
  ], await columnsOf('users'));

  // `reactions` originally keyed on (user_id, feedback_id, reaction) — feedback
  // only. Add `comment_id` ('' = a reaction on the feedback itself, otherwise
  // the comment id) and widen the primary key so a comment can carry its own
  // reactions. NOT NULL DEFAULT '' because a primary-key column cannot be NULL.
  const reactionColumns = await columnsOf('reactions');
  if (reactionColumns.size && !reactionColumns.has('comment_id')) {
    await pool.query("ALTER TABLE reactions ADD COLUMN comment_id VARCHAR(60) NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE reactions DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, feedback_id, comment_id, reaction)');
  }

  // Private feedback (DMs, project groups, the Organization channel) reuses
  // the existing `feedback`/`comments`/`reactions` machinery instead of a
  // parallel messaging schema. `visibility` keeps every pre-existing row (and
  // every future public wall post) flowing through the old unfiltered code
  // path for free via its default; `target_type` says how to interpret
  // `target_id` ('user' id, the existing 'company' sentinel, a
  // `feedback_groups` id, or 'org' for a private per-employee thread with
  // admins/managers, keyed by that employee's own user id).
  await addMissingColumns('feedback', [
    ['visibility', "VARCHAR(10) NOT NULL DEFAULT 'public'"],
    ['target_type', "VARCHAR(10) NOT NULL DEFAULT 'user'"]
  ], await columnsOf('feedback'));

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

  // One level of sub-groups (e.g. "ERP System" -> "Frontend"/"Backend").
  // NULL means a top-level group. A sub-group is a fully independent,
  // postable group (its own row, own membership) — parent_group_id is only
  // for grouping them in the UI, not an access-control relationship.
  await addMissingColumns('feedback_groups', [
    ['parent_group_id', 'VARCHAR(50) NULL']
  ], await columnsOf('feedback_groups'));

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

  // Every private message now belongs to a topic. NULL only for rows
  // written before topics existed — backfilled into a "General" topic per
  // container just below, so nothing already sent becomes unreachable.
  await addMissingColumns('feedback', [
    ['topic_id', 'VARCHAR(60) NULL']
  ], await columnsOf('feedback'));

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
    const topicId = `topic_${row.target_type}_${row.target_id}_general`.slice(0, 60);
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
    const topicId = `topic_user_${a}_${b}_general`.slice(0, 60);
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
}