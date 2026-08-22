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

/**
 * The minimum a connector needs to re-check one stored item: its own id for the
 * post, and the payload we captured. Deliberately not `MentionRecord` — that
 * lives in the store layer, which imports from here, and a connector has no
 * business with triage state anyway.
 *
 * `raw` is here because two platforms need something out of it that the
 * externalId does not carry: Mastodon's externalId is the ActivityPub URI while
 * the API is addressed by the instance-local `id`, and Reddit's kind prefix
 * decides which endpoint answers.
 */
export interface DeletionCandidate {
  externalId: string;
  raw: unknown;
}

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
   * Is this POST genuinely from the platform? Checked BEFORE `parseWebhook`, and
   * a false answer means the request is dropped unparsed.
   *
   * Any connector with a `parseWebhook` needs this. The webhook path is
   * necessarily unauthenticated at the HTTP layer — a platform cannot be handed
   * our access code — so the signature is the *only* thing standing between the
   * open internet and `ingest()`. Without it anyone can post a fabricated
   * mention, and since ingest feeds auto-resolve, a fabricated mention carrying
   * one valid code becomes a sighting on a real customer's dashboard and an
   * email telling them they were spotted online.
   *
   * Takes the RAW body, because every scheme worth having signs the bytes that
   * were sent rather than a re-serialisation of them.
   */
  verifyWebhookSignature?(rawBody: Buffer | string | undefined, headers: Record<string, string>): boolean;

  /**
   * Post a public reply/acknowledgement to a mention (used by auto-ack, opt-in).
   * Requires WRITE credentials (user-context OAuth), separate from read access —
   * so a connector may support reading mentions but not replying yet.
   */
  canReply(): boolean;
  reply?(mention: NormalizedMention, text: string): Promise<ReplyResult>;

  /**
   * "Which of these are gone?" — the deletion-propagation half of the contract.
   *
   * Given items we have stored, return the subset of `externalId`s whose content
   * is **confirmed** absent or emptied on the platform, so the sweep can strip
   * them (`src/pipeline/redact.ts`). Reddit's Developer Terms require this, and
   * it is the right behaviour everywhere: someone who deletes a post has
   * withdrawn it, and our copy is not exempt from that.
   *
   * THE CONTRACT IS ONE-DIRECTIONAL AND IT MATTERS. This answers "confirmed
   * gone", never "not confirmed present". An implementation that cannot tell —
   * the API errored, the token expired, a page 500'd, the response shape was
   * unfamiliar — must return **fewer** ids, never more, and `[]` is always a
   * safe answer. Getting that backwards turns one bad afternoon on a platform's
   * API into the permanent, irreversible erasure of the whole inbox.
   *
   * Omit it and this connector's mentions are never checked for deletion, and
   * the sweep says so out loud rather than counting them as clean.
   */
  findDeleted?(items: DeletionCandidate[]): Promise<string[]>;

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
