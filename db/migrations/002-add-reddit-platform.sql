-- 002 — add 'reddit' to the platform ENUMs, and the reply opt-out table.
--
-- Additive and re-runnable (standing order 22): MODIFY COLUMN restates the full
-- ENUM including every pre-existing value, so running it twice is a no-op and no
-- row is rewritten. 'reddit' goes SECOND to match db/schema.sql; ENUM ordinals
-- are only used for ORDER BY and nothing here orders by platform, so the
-- position is cosmetic.
--
-- Without this, every Reddit insert fails with "Data truncated for column
-- 'platform'" — and because ingest catches per-mention errors, the symptom is a
-- connector that polls happily and stores nothing.

ALTER TABLE mentions
  MODIFY COLUMN platform
    ENUM('bluesky','reddit','x','instagram','facebook','linkedin','tiktok') NOT NULL;

ALTER TABLE connector_state
  MODIFY COLUMN platform
    ENUM('bluesky','reddit','x','instagram','facebook','linkedin','tiktok') NOT NULL;

-- Authors who have told us to stop replying to them. Must outlive a restart:
-- "bad bot" means never again, not "not until the next deploy".
CREATE TABLE IF NOT EXISTS reply_opt_outs (
  platform      ENUM('bluesky','reddit','x','instagram','facebook','linkedin','tiktok') NOT NULL,
  -- Stored lower-cased by the store layer so u/Name and u/name are one person.
  author_handle VARCHAR(191) NOT NULL,
  -- Where they said it — a permalink, so a mistaken opt-out can be reviewed.
  reason        VARCHAR(2048) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (platform, author_handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
