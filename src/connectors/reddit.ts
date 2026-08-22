import { config, searchTerms } from "../config.js";
import { fetchJson } from "./http.js";
import { runFootprintSearch } from "./search.js";
import { getStore } from "../store/index.js";
import type {
  Connector,
  DeletionCandidate,
  NormalizedMention,
  PollResult,
  ReplyGate,
  ReplyResult,
} from "./types.js";

/**
 * Reddit connector.
 *
 * Reddit differs from every platform wired so far in three ways that shape this
 * file, and none of them are stylistic:
 *
 *  1. **There is no site-wide comment search.** The official Data API's
 *     `/search` covers posts only (Pushshift, which used to cover comments, is
 *     moderator-only now). A code link or a `u/qrivacyme` summon written in a
 *     COMMENT is therefore invisible to search — it can only be caught in the
 *     account's own mentions/unread inbox. So this connector polls two kinds of
 *     source, not one: public search AND the logged-in inbox.
 *  2. **Reading well needs an account.** The inbox listings are user-context
 *     only. With just a client id/secret we fall back to an app-only token
 *     (`client_credentials`), which still searches fine — so read-only degrades
 *     gracefully rather than failing, exactly like Bluesky's reply path.
 *  3. **Reddit bans bots that talk unprompted.** `mayReplyTo()` is the gate:
 *     replies are refused in subreddits on the skip list and in NSFW subs, and
 *     never twice in one thread. Combined with the fact that the footprint
 *     search only ever surfaces mentions and code links (we never keyword-hunt),
 *     the bot only ever speaks when it was summoned or when someone posted a
 *     wearer's code.
 *
 * Docs: https://www.reddit.com/dev/api  ·  OAuth: https://github.com/reddit-archive/reddit/wiki/OAuth2
 */

const OAUTH = "https://oauth.reddit.com";
const WWW = "https://www.reddit.com";

/** Listing pages cap at 100. */
const PAGE_LIMIT = 100;

/** At most this many images per item go to the QR decoder. */
const MAX_MEDIA = 4;

/** How far back to look for "did we already comment in this thread". */
const THREAD_HISTORY = 200;

/** /api/info takes up to 100 fullnames per call. */
const INFO_BATCH = 100;

/**
 * Reddit does not remove a deleted thing from /api/info — it returns it with the
 * author and the body replaced by one of these tombstones. So "still in the
 * response" is not the same as "still there", and checking only for absence
 * would find almost nothing.
 */
const TOMBSTONES = new Set(["[deleted]", "[removed]"]);

// ---------------------------------------------------------------------------
// Raw shapes (untrusted — normalise defensively)
// ---------------------------------------------------------------------------

interface RedditThing {
  kind?: string;
  data?: RedditData;
}

interface RedditData {
  id?: string;
  /** Fullname, e.g. "t3_abc123". Present on everything the API returns. */
  name?: string;
  author?: string;
  title?: string;
  selftext?: string;
  body?: string;
  subject?: string;
  url?: string;
  permalink?: string;
  /** Messages carry `context` (a permalink path) instead of `permalink`. */
  context?: string;
  subreddit?: string;
  created_utc?: number;
  over_18?: boolean;
  /** Comments only — fullname of the thread the comment sits in. */
  link_id?: string;
  link_title?: string;
  preview?: { images?: Array<{ source?: { url?: string } }> };
  media_metadata?: Record<string, { s?: { u?: string } }>;
}

interface RedditListing {
  data?: { children?: RedditThing[] };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface CachedToken {
  value: string;
  expiresAt: number;
  /** "user" can read the inbox and post; "app" can only search. */
  scope: "user" | "app";
}

let cached: CachedToken | null = null;

/** Test seam — the token is module state, so it must be clearable. */
export function resetRedditAuth(): void {
  cached = null;
  lastCallAt = 0;
}

/**
 * Reddit refuses (and rate-limits harder on) requests without a descriptive
 * User-Agent, and specifically calls out the format below. A default library UA
 * is the single most common cause of a 429 on an otherwise-idle account.
 */
export function userAgent(): string {
  if (config.reddit.userAgent) return config.reddit.userAgent;
  const who = config.reddit.username || config.watchHandle;
  return `node:qrivacy-detection:0.1.0 (by /u/${who})`;
}

export function canUseInbox(): boolean {
  const r = config.reddit;
  return Boolean(r.clientId && r.clientSecret && r.username && r.password);
}

async function accessToken(): Promise<CachedToken> {
  // 60s of slack: a token that expires mid-poll would fail the call that used it.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  const { clientId, clientSecret, username, password } = config.reddit;
  if (!clientId || !clientSecret) {
    throw new Error("reddit: REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set");
  }

  // A "script" app with an account gets a user token (inbox + replies). Without
  // the account we take an app-only token, which searches but cannot do either.
  const userContext = Boolean(username && password);
  const form: Record<string, string> = userContext
    ? { grant_type: "password", username, password }
    : { grant_type: "client_credentials" };

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const json = await paced(() =>
    fetchJson<{ access_token?: string; expires_in?: number; error?: string }>(
      `${WWW}/api/v1/access_token`,
      {
        platform: "reddit",
        method: "POST",
        form,
        headers: { Authorization: `Basic ${basic}`, "User-Agent": userAgent() },
      }
    )
  );

  if (!json.access_token) {
    // Reddit answers a bad password with 200 + {"error":"invalid_grant"}, so a
    // missing token is the real failure signal here, not the HTTP status.
    throw new Error(
      `reddit: no access token (${json.error ?? "unknown error"})` +
        (userContext && json.error === "invalid_grant"
          ? " — check REDDIT_USERNAME/REDDIT_PASSWORD, and note that with 2FA on the account the password must be sent as 'password:123456'"
          : "")
    );
  }

  cached = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: userContext ? "user" : "app",
  };
  return cached;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

let lastCallAt = 0;

/**
 * The free Data API allows 100 requests/minute per OAuth client, averaged over
 * a rolling 10-minute window. A poll cycle is a handful of calls, so simple
 * spacing keeps us an order of magnitude under the limit without needing to
 * read the X-Ratelimit headers back out of the response.
 */
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const gap = config.reddit.minIntervalMs;
  const wait = lastCallAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  return fn();
}

async function getListing(
  path: string,
  params: Record<string, string>
): Promise<RedditThing[]> {
  const token = await accessToken();
  const qs = new URLSearchParams({
    // Without raw_json=1 Reddit HTML-escapes URLs in the payload ("&amp;"),
    // which breaks every signed image URL we hand to the QR decoder.
    raw_json: "1",
    limit: String(PAGE_LIMIT),
    ...params,
  });
  const json = await paced(() =>
    fetchJson<RedditListing>(`${OAUTH}${path}?${qs}`, {
      platform: "reddit",
      headers: {
        Authorization: `Bearer ${token.value}`,
        "User-Agent": userAgent(),
      },
    })
  );
  return json?.data?.children ?? [];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Reddit has a real OR operator, so the whole footprint is one search. The
 * handle term arrives as "@qrivacyme" (the cross-platform spelling) and has to
 * be rewritten — nobody on Reddit writes an @handle, they write u/name.
 */
export function buildQuery(terms: string[], handle: string): string {
  const parts = terms.map((t) => (t.startsWith("@") ? `"u/${handle}"` : `"${t}"`));
  return [...new Set(parts)].join(" OR ");
}

/**
 * A "query" here is really a source spec, because Reddit needs three different
 * endpoints to cover one footprint:
 *
 *   search:<q>      public post search — the only site-wide surface there is
 *   domain:<host>   every submission whose LINK is a code host; catches a post
 *                   that links qxa.me with no mention of it in the title
 *   inbox:<box>     mentions + unread — the ONLY way a comment reaches us
 */
export function sourcesFor(terms: string[], handle: string, inbox: boolean): string[] {
  const sources = [`search:${buildQuery(terms, handle)}`];
  for (const host of config.codeHosts) sources.push(`domain:${host}`);
  if (inbox) sources.push("inbox:mentions", "inbox:unread");
  return sources;
}

async function fetchSource(source: string): Promise<RedditThing[]> {
  const [kind, ...rest] = source.split(":");
  const arg = rest.join(":");

  if (kind === "search") {
    return getListing("/search", {
      q: arg,
      sort: "new",
      type: "link",
      // Sightings turn up in unpleasant corners; excluding NSFW results would
      // blind us to exactly the posts a wearer most needs to know about. This
      // affects READING only — mayReplyTo() still refuses to comment there.
      include_over_18: "on",
      restrict_sr: "false",
    });
  }
  if (kind === "domain") return getListing(`/domain/${encodeURIComponent(arg)}/new`, {});
  if (kind === "inbox") return getListing(`/message/${arg}`, {});
  return [];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const IMAGE_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;

/** Everything textual an item carries, in one blob for code/handle extraction. */
export function textOf(kind: string, d: RedditData): string {
  if (kind === "t3") {
    // The submitted URL goes in deliberately: a link post to qxa.me/<code> has
    // the code ONLY in its url field, and that is a first-class detection.
    const link = d.url && !d.url.startsWith(`${WWW}/r/`) ? d.url : "";
    return [d.title, d.selftext, link].filter(Boolean).join("\n");
  }
  if (kind === "t4") return [d.subject, d.body].filter(Boolean).join("\n");
  return d.body ?? "";
}

export function permalinkOf(kind: string, d: RedditData): string | null {
  if (d.permalink) return `${WWW}${d.permalink}`;
  if (d.context) return `${WWW}${d.context}`;
  if (kind === "t4" && d.id) return `${WWW}/message/messages/${d.id}`;
  return null;
}

export function mediaOf(d: RedditData): string[] {
  const urls: string[] = [];
  if (d.url && IMAGE_RE.test(d.url)) urls.push(d.url);
  for (const img of d.preview?.images ?? []) {
    if (img.source?.url) urls.push(img.source.url);
  }
  for (const item of Object.values(d.media_metadata ?? {})) {
    if (item?.s?.u) urls.push(item.s.u);
  }
  return [...new Set(urls)].slice(0, MAX_MEDIA);
}

/** The thread ("submission") a thing belongs to, as a fullname. */
export function threadIdOf(kind: string, d: RedditData): string | null {
  if (kind === "t3") return d.name ?? (d.id ? `t3_${d.id}` : null);
  if (d.link_id) return d.link_id;
  const m = d.permalink?.match(/\/comments\/([a-z0-9]+)\//i) ?? d.context?.match(/\/comments\/([a-z0-9]+)\//i);
  return m ? `t3_${m[1]}` : null;
}

export function normalizeThing(thing: RedditThing): NormalizedMention | null {
  const kind = thing?.kind ?? "";
  const d = thing?.data;
  if (!d || !kind) return null;

  const externalId = d.name ?? (d.id ? `${kind}_${d.id}` : null);
  if (!externalId) return null;

  const author = typeof d.author === "string" ? d.author : "";
  if (!author || author === "[deleted]") return null;
  // Our own comments come back in the inbox as replies-to-replies. Ingesting
  // one would let the bot answer itself, forever.
  const me = config.reddit.username.toLowerCase();
  if (me && author.toLowerCase() === me) return null;

  return {
    platform: "reddit",
    // The fullname is stable, globally unique, and is also what /api/comment
    // needs as its parent — so the dedupe key doubles as the reply target.
    externalId,
    authorHandle: `u/${author}`,
    authorDisplayName: null,
    text: textOf(kind, d),
    permalink: permalinkOf(kind, d),
    mediaUrls: mediaOf(d),
    postedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    raw: thing,
  };
}

/** created_utc of a normalised mention, as a number. 0 when unknown. */
export function createdAtOf(m: NormalizedMention): number {
  const thing = m.raw as RedditThing | undefined;
  return Number(thing?.data?.created_utc ?? 0);
}

function dataOf(m: NormalizedMention): RedditData | null {
  const thing = m.raw as RedditThing | undefined;
  return thing?.data ?? null;
}

export function subredditOf(m: NormalizedMention): string | null {
  return dataOf(m)?.subreddit ?? null;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const redditConnector: Connector = {
  platform: "reddit",

  isConfigured() {
    // Client credentials alone are enough to READ. Unauthenticated access is
    // deliberately not attempted: Reddit throttles or blocks it outright.
    return Boolean(config.reddit.clientId && config.reddit.clientSecret);
  },

  async poll(cursor: string | null): Promise<PollResult> {
    return runFootprintSearch<RedditThing>(
      {
        platform: "reddit",
        terms: searchTerms(),

        toQueries: (terms) =>
          sourcesFor(terms, config.watchHandle, canUseInbox()),

        fetchPage: (source) => fetchSource(source),

        normalize: normalizeThing,

        isNew(m, cur) {
          // No server-side "since" on any of the three sources, so freshness is
          // filtered here against created_utc — the same client-side shape as
          // Bluesky, for the same reason.
          if (!cur) return true;
          const at = createdAtOf(m);
          return at ? at > Number(cur) : true;
        },

        advanceCursor(all, cur) {
          const newest = all.reduce((max, m) => Math.max(max, createdAtOf(m)), 0);
          if (!newest) return cur;
          // Never move backwards, or a late-indexed item replays every cycle.
          return !cur || newest > Number(cur) ? String(newest) : cur;
        },

        maxReads: config.maxReadsPerPoll,
      },
      cursor
    );
  },

  canReply() {
    // Posting is user-context only — an app-only token cannot comment.
    return canUseInbox();
  },

  /**
   * Which of these are gone from Reddit? Required by the Developer Terms, and
   * the reason `externalId` is stored as the fullname: it is exactly what
   * /api/info takes, 100 at a time, so this costs one request per 100 rows.
   *
   * Three ways a thing counts as gone, and only the first is what you would
   * guess:
   *   - absent from the response entirely;
   *   - present with `author` == "[deleted]" — the author removed their account
   *     or the post, and Reddit leaves a tombstone rather than a hole;
   *   - present with the body replaced by "[deleted]"/"[removed]".
   *
   * Moderator removal lands in the third case alongside author deletion, and we
   * treat it the same. Reddit's requirement is about deletion, so that is
   * stricter than asked for — deliberately. We would rather drop a post a mod
   * hid than keep one an author withdrew, and nothing downstream needs the text
   * of a removed post.
   */
  async findDeleted(items: DeletionCandidate[]): Promise<string[]> {
    const gone: string[] = [];

    for (let i = 0; i < items.length; i += INFO_BATCH) {
      const batch = items.slice(i, i + INFO_BATCH);
      // Fullnames only. Anything else in externalId is not addressable here, and
      // guessing would be worse than skipping it.
      const ids = batch.map((b) => b.externalId).filter((id) => /^t\d_[a-z0-9]+$/i.test(id));
      if (!ids.length) continue;

      const things = await getListing("/api/info", { id: ids.join(",") });

      // A batch that returns NOTHING is treated as unknown, not as "all gone".
      // An API hiccup, an expired token or an unfamiliar response shape all look
      // like an empty listing, and acting on it would irreversibly erase up to
      // 100 rows at a stroke. Returning [] just defers to the next sweep.
      if (!things.length) {
        console.warn(`[redact] reddit: /api/info returned nothing for ${ids.length} ids — skipping this batch`);
        continue;
      }

      const seen = new Map<string, RedditData>();
      for (const t of things) {
        const d = t?.data;
        if (d?.name) seen.set(d.name, d);
      }

      for (const id of ids) {
        const d = seen.get(id);
        if (!d) {
          gone.push(id);
          continue;
        }
        const author = (d.author ?? "").trim();
        const body = (d.selftext ?? d.body ?? "").trim();
        if (TOMBSTONES.has(author) || TOMBSTONES.has(body)) gone.push(id);
      }
    }

    return gone;
  },

  /**
   * The etiquette gate. Reddit's tolerance for bots is entirely local: what is
   * welcome in one subreddit is an instant ban in the next, and the account is
   * not replaceable (a new one has no history and gets filtered as spam). So a
   * refusal here is a normal outcome, not an error.
   */
  async mayReplyTo(m: NormalizedMention): Promise<ReplyGate> {
    const d = dataOf(m);
    const sub = (d?.subreddit ?? "").toLowerCase();

    if (sub && config.reddit.skipSubreddits.includes(sub)) {
      return { ok: false, reason: `r/${sub} is on REDDIT_SKIP_SUBREDDITS` };
    }
    // A wearer's code showing up in an NSFW sub is a sighting worth recording,
    // but a privacy service commenting there is not a good look for anyone —
    // least of all the wearer we would be drawing attention to.
    if (d?.over_18) return { ok: false, reason: `r/${sub || "?"} is NSFW` };

    const thread = threadIdOf((m.raw as RedditThing)?.kind ?? "", d ?? {});
    if (thread) {
      // One comment per thread. Three people quoting the same qxa.me link in
      // one discussion must not produce three identical bot comments.
      const responded = await getStore().list({
        platform: "reddit",
        status: "responded",
        limit: THREAD_HISTORY,
      });
      const already = responded.some((r) => {
        const rd = (r.raw as RedditThing | undefined)?.data;
        const rk = (r.raw as RedditThing | undefined)?.kind ?? "";
        return rd ? threadIdOf(rk, rd) === thread : false;
      });
      if (already) return { ok: false, reason: `already replied in ${thread}` };
    }

    return { ok: true };
  },

  async reply(m: NormalizedMention, text: string): Promise<ReplyResult> {
    if (!this.canReply()) {
      return {
        ok: false,
        error: "reddit: replying needs REDDIT_USERNAME + REDDIT_PASSWORD (user-context token)",
      };
    }
    try {
      const token = await accessToken();
      const json = await paced(() =>
        fetchJson<CommentResponse>(`${OAUTH}/api/comment`, {
          platform: "reddit",
          method: "POST",
          form: { api_type: "json", thing_id: m.externalId, text },
          headers: {
            Authorization: `Bearer ${token.value}`,
            "User-Agent": userAgent(),
          },
        })
      );

      // THE TRAP: Reddit reports application errors with HTTP 200 and an
      // `errors` array — rate limits, removed parents, subreddit bans, shadow
      // bans. Trusting the status code here means logging "replied" for a
      // comment that was never posted.
      const errors = json?.json?.errors ?? [];
      if (errors.length) {
        return { ok: false, error: `reddit: ${errors.map((e) => e.join(" ")).join("; ")}` };
      }
      return { ok: true, externalId: json?.json?.data?.things?.[0]?.data?.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

interface CommentResponse {
  json?: {
    errors?: string[][];
    data?: { things?: Array<{ data?: { name?: string } }> };
  };
}
