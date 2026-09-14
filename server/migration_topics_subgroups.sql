-- PulseFeedback manual migration: topics, sub-groups, unread tracking
--
-- Adds ONLY what's new since the private-feedback-inbox migration (that one
-- already added permission_role, feedback.visibility/target_type,
-- feedback_groups, and group_members — this assumes those already exist).
--
-- Safe to run against a live database: every statement is additive (new
-- table or new nullable column), nothing existing is dropped, renamed, or
-- rewritten. Still, back up first — see the note at the bottom.
--
-- If you're not sure whether this has already been applied, run each
-- section's "-- check" query first; skip a section if it shows the column/
-- table already exists (re-running an ALTER ADD COLUMN on a column that's
-- already there will error out, unlike the app's own idempotent migration
-- which checks first automatically).

SET NAMES utf8mb4;

-- ============================================================
-- 1. Sub-groups: one level of nesting (e.g. "ERP System" -> "Frontend").
--    NULL = a top-level group. A sub-group is a fully independent,
--    postable group with its own membership — this column is only for
--    grouping them in the UI.
-- ============================================================
-- check: SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback_groups' AND COLUMN_NAME = 'parent_group_id';

ALTER TABLE `feedback_groups`
  ADD COLUMN `parent_group_id` varchar(50) DEFAULT NULL,
  ADD KEY `idx_feedback_groups_parent` (`parent_group_id`),
  ADD CONSTRAINT `fk_feedback_groups_parent` FOREIGN KEY (`parent_group_id`) REFERENCES `feedback_groups` (`id`) ON DELETE CASCADE;

-- ============================================================
-- 2. Topics: every private conversation (a DM, a group, or an employee's
--    Organization thread) is topic-based — multiple named topics can run
--    side by side within the same container, each its own message thread.
--    target_type/target_id name the container the same way
--    feedback.target_type/target_id already do.
-- ============================================================
-- check: SHOW TABLES LIKE 'topics';

CREATE TABLE IF NOT EXISTS `topics` (
  `id`          varchar(60)  NOT NULL,
  `target_type` varchar(10)  NOT NULL,
  `target_id`   varchar(50)  NOT NULL,
  `name`        varchar(160) NOT NULL,
  `created_by`  varchar(50)  NOT NULL,
  `created_at`  timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_topics_target` (`target_type`, `target_id`),
  CONSTRAINT `fk_topics_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- 3. Every private message now belongs to a topic. NULL only for rows
--    written before topics existed — backfilled into a "General" topic
--    per container in step 5 below, so nothing already sent disappears.
-- ============================================================
-- check: SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' AND COLUMN_NAME = 'topic_id';

ALTER TABLE `feedback`
  ADD COLUMN `topic_id` varchar(60) DEFAULT NULL,
  ADD KEY `idx_feedback_topic` (`topic_id`);

-- ============================================================
-- 4. Read markers, per topic per user — basis for unread counts (the
--    Feedbacks nav badge and the per-conversation indicators). Absence of
--    a row means "never opened", i.e. everything in the topic is unread.
-- ============================================================
-- check: SHOW TABLES LIKE 'topic_reads';

CREATE TABLE IF NOT EXISTS `topic_reads` (
  `topic_id`      varchar(60) NOT NULL,
  `user_id`       varchar(50) NOT NULL,
  `last_read_at`  timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`topic_id`, `user_id`),
  CONSTRAINT `fk_topic_reads_topic` FOREIGN KEY (`topic_id`) REFERENCES `topics` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_topic_reads_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- 5. Backfill: any private message sent before topics existed (topic_id
--    still NULL) gets folded into one "General" topic per container, so
--    it stays reachable instead of disappearing from the new topic-scoped
--    UI. A no-op if there's no such data (e.g. the feature only just went
--    live and nobody has sent a private message yet).
--
--    Split into two passes because a DM's target_id is directional per
--    row (who THIS message was sent to) — a back-and-forth conversation
--    has rows pointing both ways, so grouping DMs on target_id directly
--    would incorrectly split one conversation into two "General" topics.
--    Group/org rows don't have this problem: target_id is already a
--    stable per-container key (a group's own id, or — for org — the
--    employee whose thread it is) regardless of who's sending.
-- ============================================================
-- check: SELECT COUNT(*) FROM feedback WHERE visibility = 'private' AND topic_id IS NULL;

-- 5a. group / org
INSERT IGNORE INTO `topics` (`id`, `target_type`, `target_id`, `name`, `created_by`)
SELECT
  LEFT(CONCAT('topic_', target_type, '_', target_id, '_general'), 60),
  target_type, target_id, 'General', MIN(sender_id)
FROM `feedback`
WHERE visibility = 'private' AND target_type IN ('group', 'org') AND topic_id IS NULL
GROUP BY target_type, target_id;

UPDATE `feedback`
SET topic_id = LEFT(CONCAT('topic_', target_type, '_', target_id, '_general'), 60)
WHERE visibility = 'private' AND target_type IN ('group', 'org') AND topic_id IS NULL;

-- 5b. user (DM) — grouped on the unordered {sender_id, target_id} pair
INSERT IGNORE INTO `topics` (`id`, `target_type`, `target_id`, `name`, `created_by`)
SELECT
  LEFT(CONCAT('topic_user_', LEAST(sender_id, target_id), '_', GREATEST(sender_id, target_id), '_general'), 60),
  'user', GREATEST(sender_id, target_id), 'General', LEAST(sender_id, target_id)
FROM `feedback`
WHERE visibility = 'private' AND target_type = 'user' AND topic_id IS NULL
GROUP BY LEAST(sender_id, target_id), GREATEST(sender_id, target_id);

UPDATE `feedback`
SET topic_id = LEFT(CONCAT('topic_user_', LEAST(sender_id, target_id), '_', GREATEST(sender_id, target_id), '_general'), 60)
WHERE visibility = 'private' AND target_type = 'user' AND topic_id IS NULL;

-- ============================================================
-- Before running this against production: take a backup first, e.g.
--   mysqldump -h <host> -u <user> -p <database> > pulsefeedback_backup_$(date +%Y%m%d_%H%M%S).sql
-- Run that from wherever you can reach the production MySQL host (your
-- hosting panel likely also offers a one-click export/backup tool).
-- ============================================================
