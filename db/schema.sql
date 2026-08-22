-- QRivacyDetection datastore.
-- Owns the raw "mention inbox". Linking a mention to a QRivacy wearer's `code`
-- and creating a `sighting` is a downstream step (and may write into the
-- separate qrivacy DB) — this schema stays independent of it.

CREATE TABLE IF NOT EXISTS mentions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform      ENUM('bluesky','reddit','mastodon','x','instagram','facebook','linkedin','tiktok') NOT NULL,
  -- Platform's own id for the post/comment. (platform, external_id) is unique
  -- so the same mention arriving twice (poll overlap + webhook) is idempotent.
  external_id   VARCHAR(191) NOT NULL,
  author_handle VARCHAR(191) NULL,
  author_name   VARCHAR(255) NULL,
  text          TEXT NULL,
  permalink     VARCHAR(2048) NULL,
  media_urls    JSON NULL,
  posted_at     DATETIME NULL,

  -- Why this detection fired.
  match_type    ENUM('handle_mention','code_link','qr_image','unknown')
                  NOT NULL DEFAULT 'unknown',
  -- qrivacy codes recovered from text and/or decoded QR images.
  extracted_codes JSON NULL,

  -- Triage lifecycle:
  --   new       -> just ingested, not yet looked at
  --   reviewing -> a human/rule is working it
  --   linked    -> matched to a QRivacy code / sighting created
  --   responded -> we replied/acknowledged on-platform
  --   ignored   -> spam / not actionable
  status        ENUM('new','reviewing','linked','responded','ignored')
                  NOT NULL DEFAULT 'new',

  -- Optional links out to the qrivacy app once triaged (nullable by design).
  linked_code   VARCHAR(64) NULL,           -- qrivacy code string, if resolved
  linked_sighting_id BIGINT UNSIGNED NULL,  -- id in qrivacy.sightings, if created

  raw           JSON NULL,                  -- full source payload for audit
  discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Deletion propagation and retention (migration 004). We are required to drop
  -- content the author deleted on-platform; `redacted_at` records that we did.
  -- Redaction strips the platform's content and the author's identity and keeps
  -- the row, because a sighting already delivered to a customer references it.
  last_checked_at DATETIME NULL,           -- last "is this still there?" ask; NULL = never
  redacted_at     DATETIME NULL,
  redacted_reason ENUM('deleted_upstream','retention') NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_mentions_platform_ext (platform, external_id),
  KEY idx_mentions_status (status),
  KEY idx_mentions_posted (posted_at),
  KEY idx_mentions_recheck (platform, redacted_at, last_checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-connector polling cursor (since_id / pagination token), one row each.
-- `cursor` is a RESERVED WORD in MariaDB/MySQL — it must stay backticked in
-- every statement that names the column, here and in src/store/mysql.ts.
CREATE TABLE IF NOT EXISTS connector_state (
  platform   ENUM('bluesky','reddit','mastodon','x','instagram','facebook','linkedin','tiktok') NOT NULL,
  `cursor`   VARCHAR(512) NULL,
  last_run_at DATETIME NULL,
  last_error TEXT NULL,
  PRIMARY KEY (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Authors who have told us to stop replying to them ("bad bot", "opt out").
-- Must outlive a restart: that request means never again, not "not until the
-- next deploy". Written by src/pipeline/optout.ts, checked before every reply.
CREATE TABLE IF NOT EXISTS reply_opt_outs (
  platform      ENUM('bluesky','reddit','mastodon','x','instagram','facebook','linkedin','tiktok') NOT NULL,
  -- Stored lower-cased by the store layer so u/Name and u/name are one person.
  author_handle VARCHAR(191) NOT NULL,
  -- Where they said it — a permalink, so a mistaken opt-out can be reviewed.
  reason        VARCHAR(2048) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (platform, author_handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
