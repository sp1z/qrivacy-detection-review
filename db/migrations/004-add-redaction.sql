-- Deletion propagation + retention.
--
-- Reddit's Developer Terms (and Bluesky's and Mastodon's norms, and plain
-- decency) require that content deleted on the platform is deleted by us.
-- Nothing did that: a `mentions` row kept its text and raw payload forever,
-- including for a post whose author had since removed it.
--
-- Redaction is NOT row deletion, deliberately. The row's id is referenced by a
-- sighting already delivered to a customer, and by detection_reports on the
-- qrivacy side; dropping it would tear a hole in an audit trail to satisfy an
-- obligation that is about the AUTHOR's content, not about our own record that
-- something happened. So the platform's content and the author's identity go,
-- and the skeleton stays.
--
-- Additive and re-runnable (standing order: mysqldump first — DDL is not
-- transactional). MariaDB supports IF NOT EXISTS on ADD COLUMN and ADD KEY.

ALTER TABLE mentions
  -- When we last asked the platform "is this still there?". NULL = never asked,
  -- which is why the sweep orders NULLs first: the backlog gets seen before the
  -- rows we already know about.
  ADD COLUMN IF NOT EXISTS last_checked_at DATETIME NULL AFTER updated_at,
  ADD COLUMN IF NOT EXISTS redacted_at     DATETIME NULL AFTER last_checked_at,
  -- Why it was stripped. 'deleted_upstream' is the obligation; 'retention' is
  -- our own ceiling. Keeping them apart matters: one is evidence we honoured a
  -- deletion, the other is evidence we do not hoard.
  ADD COLUMN IF NOT EXISTS redacted_reason ENUM('deleted_upstream','retention') NULL
                             AFTER redacted_at;

-- The sweep's access pattern: one platform, not yet redacted, least recently
-- checked first.
ALTER TABLE mentions
  ADD KEY IF NOT EXISTS idx_mentions_recheck (platform, redacted_at, last_checked_at);
