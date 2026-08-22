/**
 * The pluggable connector contract. Every platform (X, Instagram, Facebook,
 * LinkedIn, TikTok) implements this same shape. Which ones are *enabled* is
 * config-driven (ENABLED_CONNECTORS); the pipeline downstream is identical.
 *
 * Two acquisition modes exist, and a connector may support one or both:
 *   - poll():    we ask the platform "what's new" on a schedule (X search,
 *                LinkedIn org mentions).
 *   - webhook(): the platform POSTs us mentions as they happen (Instagram &
 *                Facebook mention callbacks). The HTTP server routes to these.
 */

export type Platform =
  | "bluesky"
  | "reddit"
  | "mastodon"
  | "x"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "tiktok";

/**
 * A single mention, normalized to one shape regardless of source platform.
 * This is what lands in the `mentions` inbox table. It deliberately does NOT
 * assume we know which QRivacy wearer it concerns — resolving a mention to a
 * `code` (and creating a sighting) is a downstream triage step.
 */
export interface NormalizedMention {
  platform: Platform;
  /** Platform's own id for the post/comment — used for idempotent dedupe. */
  externalId: string;
  /** Public author handle, e.g. "@someone" (never a private identifier). */
  authorHandle: string | null;
  authorDisplayName: string | null;
  /** Text of the post/comment that mentioned us. */
  text: string;
  /** Canonical public URL of the mention, if the platform exposes one. */
  permalink: string | null;
  /** URLs of any attached media (images/video). */
  mediaUrls: string[];
  /** When the mention was created on-platform (ISO 8601). */
  postedAt: string | null;
  /**
   * Why this detection fired: a handle mention, a code link in the text, or a
   * QR code decoded from an image. Set by the pipeline (ingest) after enrichment
   * — a connector may leave it undefined.
   */
  matchType?: MatchType;
  /** qrivacy codes recovered from text and/or decoded QR images, deduped. */
  extractedCodes?: string[];
  /** Raw payload for audit/debug — stored as JSON, never trusted for logic. */
  raw: unknown;
}

export type MatchType = "handle_mention" | "code_link" | "qr_image" | "unknown";

export interface PollResult {
  mentions: NormalizedMention[];
  /** Opaque cursor to persist and pass back next poll (since_id, pagination). */
  cursor?: string | null;
}

export interface ReplyResult {
  ok: boolean;
  /** Platform id of the reply we posted, if any. */
  externalId?: string;
  error?: string;
}

/** Outcome of the per-mention etiquette check (see `Connector.mayReplyTo`). */
export type ReplyGate = { ok: true } | { ok: false; reason: string };

export interface Connector {
  platform: Platform;

  /** True if the required credentials/config are present for this connector. */
  isConfigured(): boolean;

  /**
   * Pull new mentions since `cursor`. Return [] (not throw) when nothing new.
   * Omit entirely for webhook-only platforms.
   */
  poll?(cursor: string | null): Promise<PollResult>;

  /**
   * Handle an inbound webhook verification handshake (GET challenge).
   * Return the string to echo, or null if this isn't our request.
   */
  verifyWebhook?(query: Record<string, string>): string | null;

  /**
   * Parse an inbound webhook POST body into normalized mentions.
   * Return [] if the payload contains no mentions we care about.
   */
  parseWebhook?(body: unknown, headers: Record<string, string>): NormalizedMention[];

  /**
   * Post a public reply/acknowledgement to a mention (used by auto-ack, opt-in).
   * Requires WRITE credentials (user-context OAuth), separate from read access —
   * so a connector may support reading mentions but not replying yet.
   */
  canReply(): boolean;
  reply?(mention: NormalizedMention, text: string): Promise<ReplyResult>;

  /**
   * Optional per-mention etiquette gate, asked before every reply. `canReply()`
   * answers "do we hold write credentials"; this answers "should we speak to
   * THIS one" — a subreddit that bans bots, a thread we already commented in,
   * an NSFW context. A refusal is a normal outcome, not a failure: the mention
   * is left for a human rather than logged as a broken reply.
   *
   * Omit it and every mention is fair game, which is right for platforms where
   * a reply to a tag is unremarkable (Bluesky) and wrong for Reddit.
   */
  mayReplyTo?(mention: NormalizedMention): Promise<ReplyGate>;
}
