import type { MatchType, NormalizedMention, Platform } from "../connectors/types.js";

export type MentionStatus =
  | "new"
  | "reviewing"
  | "linked"
  | "responded"
  | "ignored";

export const MENTION_STATUSES: MentionStatus[] = [
  "new",
  "reviewing",
  "linked",
  "responded",
  "ignored",
];

/** A mention as it lives in the inbox — the normalized signal plus triage state. */
export interface MentionRecord extends NormalizedMention {
  /** String id so memory (counter) and MySQL (bigint) present the same shape. */
  id: string;
  matchType: MatchType;
  extractedCodes: string[];
  status: MentionStatus;
  linkedCode: string | null;
  linkedSightingId: number | null;
  discoveredAt: string;
  updatedAt: string;
  /** Last "is this still on the platform?" ask. null = never checked. */
  lastCheckedAt: string | null;
  /** Set once the platform content has been stripped. See RedactReason. */
  redactedAt: string | null;
  redactedReason: RedactReason | null;
}

/**
 * Why a mention was stripped.
 *
 * `deleted_upstream` — the author removed it, and we are required to follow.
 * `retention`        — it simply got old. Our own ceiling, not an obligation.
 *
 * They are kept apart because they answer different questions from different
 * people: the first is the evidence that we honour deletions, the second is the
 * evidence that we do not hoard. A single "redacted" flag would answer neither.
 */
export type RedactReason = "deleted_upstream" | "retention";

export interface MentionFilter {
  status?: MentionStatus;
  platform?: Platform;
  limit?: number;
}

export interface MentionPatch {
  status?: MentionStatus;
  linkedCode?: string | null;
  linkedSightingId?: number | null;
}

/**
 * Storage seam. Two implementations: MySQL (real) and in-memory (demo, used
 * automatically when the DB isn't configured — mirrors the qrivacy app so the
 * triage inbox is clickable with zero setup).
 */
export interface MentionStore {
  readonly kind: "mysql" | "memory";
  init(): Promise<void>;

  /** Idempotent on (platform, external_id). inserted=false if already present. */
  insert(m: NormalizedMention): Promise<{ inserted: boolean; record: MentionRecord }>;
  get(id: string): Promise<MentionRecord | null>;
  list(filter?: MentionFilter): Promise<MentionRecord[]>;
  update(id: string, patch: MentionPatch): Promise<MentionRecord | null>;
  counts(): Promise<Record<MentionStatus, number>>;

  getCursor(platform: Platform): Promise<string | null>;
  setCursor(platform: Platform, cursor: string | null, error?: string | null): Promise<void>;

  /**
   * Record that an author has told us to stop talking to them, and check it
   * before we reply. This has to be durable and cross-restart: "bad bot" means
   * *never again*, not "not until the service restarts". Handles are stored
   * lower-cased so u/Name and u/name are the same person.
   */
  optOut(platform: Platform, authorHandle: string, reason: string | null): Promise<void>;
  isOptedOut(platform: Platform, authorHandle: string): Promise<boolean>;

  // -- Deletion propagation and retention (see src/pipeline/redact.ts) --------

  /**
   * Un-redacted mentions for one platform, least-recently-checked first, with
   * never-checked rows ahead of everything. That ordering is the whole design:
   * a bounded sweep run repeatedly walks the entire table without needing to
   * remember where it got to, and a newly-imported backlog is not starved by
   * rows we have already looked at.
   */
  dueForDeletionCheck(platform: Platform, limit: number): Promise<MentionRecord[]>;

  /**
   * Record that we asked about these, whatever the answer was.
   *
   * This MUST be called for everything asked about, not only for what came back
   * deleted — otherwise surviving rows keep their old `last_checked_at`, sort to
   * the front again on the next sweep, and the sweep re-checks the same handful
   * forever while the rest of the table is never reached.
   */
  markChecked(ids: string[]): Promise<void>;

  /**
   * Strip the platform's content and the author's identity from these rows and
   * mark them redacted. Returns how many rows actually changed.
   *
   * Not a delete: the id is referenced by sightings already delivered to
   * customers. What survives is the skeleton — id, platform, external id,
   * timestamps, triage status, and the qrivacy code it was linked to, which is
   * our data and not the author's.
   */
  redact(ids: string[], reason: RedactReason): Promise<number>;

  /**
   * Un-redacted mentions older than `days`, by the time we discovered them.
   * Feeds the retention ceiling, which applies regardless of whether the post
   * still exists — the honest answer to "how long do you keep it?".
   */
  olderThan(days: number, limit: number): Promise<MentionRecord[]>;

  close(): Promise<void>;
}

export function emptyCounts(): Record<MentionStatus, number> {
  return { new: 0, reviewing: 0, linked: 0, responded: 0, ignored: 0 };
}
