-- PulseFeedback production schema
-- Run this against an empty MySQL 8.0+ / MariaDB 10.4+ database.
-- The database itself should already exist and be selected before running.
-- All statements use IF NOT EXISTS so re-running is safe.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `users` (
  `id`               varchar(50)  NOT NULL,
  `external_id`      varchar(50)  DEFAULT NULL,
  `name`             varchar(120) NOT NULL,
  `email`            varchar(190) DEFAULT NULL,
  `role_title`       varchar(120) DEFAULT NULL,
  `department`       varchar(80)  NOT NULL DEFAULT 'General',
  `avatar`           varchar(500) DEFAULT NULL,
  `skills`           text         DEFAULT NULL,
  `source`           varchar(30)  NOT NULL DEFAULT 'local',
  `synced_at`        timestamp    NULL DEFAULT NULL,
  `permission_role`  varchar(20)  NOT NULL DEFAULT 'user',
  PRIMARY KEY (`id`),
  KEY `idx_users_external_id` (`external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `feedback` (
  `id`           varchar(50)  NOT NULL,
  `sender_id`    varchar(50)  NOT NULL,
  `target_id`    varchar(50)  NOT NULL,
  `target_name`  varchar(160) NOT NULL,
  `content`      text         NOT NULL,
  `is_anonymous` tinyint(1)   NOT NULL DEFAULT 0,
  `is_edited`    tinyint(1)   NOT NULL DEFAULT 0,
  `visibility`   varchar(10)  NOT NULL DEFAULT 'public',
  `target_type`  varchar(10)  NOT NULL DEFAULT 'user',
  `topic_id`     varchar(60)  DEFAULT NULL,
  `attachment_id` varchar(60) DEFAULT NULL,
  `reply_to_id`  varchar(60)  DEFAULT NULL,
  `pinned_at`    timestamp    NULL DEFAULT NULL,
  `pinned_by`    varchar(50)  DEFAULT NULL,
  `pinned_until` timestamp    NULL DEFAULT NULL,
  `created_at`   timestamp    NOT NULL DEFAULT current_timestamp(),
  `updated_at`   timestamp    NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_feedback_target`  (`target_id`),
  KEY `idx_feedback_sender`  (`sender_id`),
  KEY `idx_feedback_created` (`created_at`),
  KEY `idx_feedback_topic`   (`topic_id`),
  CONSTRAINT `fk_feedback_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `comments` (
  `id`           varchar(60) NOT NULL,
  `feedback_id`  varchar(50) NOT NULL,
  `parent_id`    varchar(60) DEFAULT NULL,
  `sender_id`    varchar(50) NOT NULL,
  `content`      text        NOT NULL,
  `is_anonymous` tinyint(1)  NOT NULL DEFAULT 0,
  `is_edited`    tinyint(1)  NOT NULL DEFAULT 0,
  `created_at`   timestamp   NOT NULL DEFAULT current_timestamp(),
  `updated_at`   timestamp   NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_comments_feedback` (`feedback_id`),
  KEY `fk_comments_parent`    (`parent_id`),
  KEY `fk_comments_sender`    (`sender_id`),
  CONSTRAINT `fk_comments_feedback` FOREIGN KEY (`feedback_id`) REFERENCES `feedback` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comments_parent`   FOREIGN KEY (`parent_id`)   REFERENCES `comments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comments_sender`   FOREIGN KEY (`sender_id`)   REFERENCES `users`    (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `reactions` (
  `user_id`     varchar(50) NOT NULL,
  `feedback_id` varchar(50) NOT NULL,
  `reaction`    varchar(20) NOT NULL,
  `created_at`  timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`, `feedback_id`, `reaction`),
  KEY `fk_reactions_feedback` (`feedback_id`),
  CONSTRAINT `fk_reactions_user`     FOREIGN KEY (`user_id`)     REFERENCES `users`    (`id`),
  CONSTRAINT `fk_reactions_feedback` FOREIGN KEY (`feedback_id`) REFERENCES `feedback` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `private_remarks` (
  `id`         varchar(60)  NOT NULL,
  `author_id`  varchar(50)  NOT NULL,
  `target_id`  varchar(50)  NOT NULL,
  `content`    varchar(500) NOT NULL,
  `created_at` timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_remarks_owner_target` (`author_id`, `target_id`),
  KEY `fk_remarks_target`        (`target_id`),
  CONSTRAINT `fk_remarks_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_remarks_target` FOREIGN KEY (`target_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Project groups for the Feedbacks tab. Named `feedback_groups`, not
-- `groups` — GROUPS is a reserved word in current MySQL/MariaDB.
-- `parent_group_id` supports one level of sub-groups (e.g. "ERP System" ->
-- "Frontend"/"Backend") — NULL means top-level. A sub-group is a fully
-- independent, postable group with its own membership; the parent link is
-- only for grouping them in the UI, not an access-control relationship.
CREATE TABLE IF NOT EXISTS `feedback_groups` (
  `id`               varchar(50)  NOT NULL,
  `name`             varchar(160) NOT NULL,
  `created_by`       varchar(50)  NOT NULL,
  `parent_group_id`  varchar(50)  DEFAULT NULL,
  `avatar`           varchar(500) DEFAULT NULL,
  `created_at`       timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_feedback_groups_created_by` (`created_by`),
  KEY `idx_feedback_groups_parent`     (`parent_group_id`),
  CONSTRAINT `fk_feedback_groups_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_feedback_groups_parent` FOREIGN KEY (`parent_group_id`) REFERENCES `feedback_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `group_members` (
  `group_id`   varchar(50) NOT NULL,
  `user_id`    varchar(50) NOT NULL,
  `added_by`   varchar(50) DEFAULT NULL,
  `role`       varchar(10) NOT NULL DEFAULT 'member',
  `created_at` timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`group_id`, `user_id`),
  KEY `idx_group_members_user` (`user_id`),
  CONSTRAINT `fk_group_members_group` FOREIGN KEY (`group_id`) REFERENCES `feedback_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_group_members_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Topics: every private conversation (a DM, a group, or an employee's
-- Organization thread) is topic-based — multiple named topics can run side
-- by side within the same container, each with its own message thread.
-- `target_type`/`target_id` name the container exactly like
-- `feedback.target_type`/`target_id` do, so a topic's visibility is governed
-- by the identical access rule as its container.
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

-- Read markers, per topic per user — basis for unread counts. Absence of a
-- row means "never opened", i.e. everything in the topic is unread.
CREATE TABLE IF NOT EXISTS `topic_reads` (
  `topic_id`      varchar(60) NOT NULL,
  `user_id`       varchar(50) NOT NULL,
  `last_read_at`  timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`topic_id`, `user_id`),
  CONSTRAINT `fk_topic_reads_topic` FOREIGN KEY (`topic_id`) REFERENCES `topics` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_topic_reads_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Chat attachments, stored in the database (no persistent disk on Vercel);
-- 3 MB per file, enforced by the upload route.
CREATE TABLE IF NOT EXISTS `attachments` (
  `id`          varchar(60)  NOT NULL,
  `uploader_id` varchar(50)  NOT NULL,
  `filename`    varchar(255) NOT NULL,
  `mime_type`   varchar(120) NOT NULL,
  `size`        int          NOT NULL,
  `data`        mediumblob   NOT NULL,
  `created_at`  timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_attachments_uploader` (`uploader_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- "X is typing…" heartbeats, one row per person per topic.
CREATE TABLE IF NOT EXISTS `topic_typing` (
  `topic_id`   varchar(60) NOT NULL,
  `user_id`    varchar(50) NOT NULL,
  `updated_at` timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`topic_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- "Delete for me": chat messages a person hid from their own view only.
CREATE TABLE IF NOT EXISTS `message_hidden` (
  `user_id`     varchar(50) NOT NULL,
  `feedback_id` varchar(60) NOT NULL,
  `created_at`  timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`, `feedback_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Per-person starred chat messages.
CREATE TABLE IF NOT EXISTS `message_stars` (
  `user_id`     varchar(50) NOT NULL,
  `feedback_id` varchar(60) NOT NULL,
  `created_at`  timestamp   NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`, `feedback_id`),
  KEY `idx_message_stars_feedback` (`feedback_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
