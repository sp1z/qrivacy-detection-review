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
}

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

  close(): Promise<void>;
}

export function emptyCounts(): Record<MentionStatus, number> {
  return { new: 0, reviewing: 0, linked: 0, responded: 0, ignored: 0 };
}
