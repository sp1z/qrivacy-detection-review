import dotenv from "dotenv";
import type { Platform } from "./connectors/types.js";

// `dotenv/config` only ever loads `.env`, but the README, DEPLOY.md and
// .env.example all tell you to put credentials in `.env.local` — so a correctly
// followed deploy came up with no DB and no connectors, silently falling back
// to the in-memory demo store. Load both, `.env.local` first.
//
// dotenv never overwrites a variable that is already set, so precedence runs
// real environment (systemd's PORT/HOST) > .env.local > .env. Paths resolve
// against process.cwd(), i.e. the service's WorkingDirectory.
dotenv.config({ path: ".env.local" });
dotenv.config();

const env = (k: string, fallback = ""): string => process.env[k] ?? fallback;

const list = (k: string, fallback: string): string[] =>
  env(k, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// A code link is a host + path prefix + the code, e.g. "qxa.me/<code>" (code at
// root) or "qrivacy.me/r/<code>". Each domain keeps its OWN scheme, so we list
// full prefixes rather than crossing hosts × paths (which would misread
// qrivacy.me/about as a code). Add new domains/paths here — nothing hardcoded.
const codeLinkPrefixes = list(
  "CODE_LINK_PREFIXES",
  "qxa.me/,qrivacy.me/r/,qrivacy.russellpreece.co.uk/r/"
).map((p) => p.replace(/^https?:\/\//i, "").replace(/^www\./i, ""));

// Bare hosts, derived from the prefixes — used for footprint search and for
// excluding our own links from "candidate source URL" lists.
const codeHosts = [
  ...new Set(codeLinkPrefixes.map((p) => p.split("/")[0].toLowerCase())),
];

export const config = {
  watchHandle: env("WATCH_HANDLE", "qrivacyme").replace(/^@/, ""),

  // Shared code guarding the triage UI and API (see gate.ts). Unset means the
  // triage surface refuses to serve at all — it must never mean "wide open".
  accessCode: env("TRIAGE_ACCESS_CODE"),
  port: Number(env("PORT", "4010")),
  host: env("HOST", "127.0.0.1"),
  publicBaseUrl: env("PUBLIC_BASE_URL"),

  // Full "host/path/" prefixes that a code follows (see above), and the bare
  // hosts derived from them.
  codeLinkPrefixes,
  codeHosts,

  enabledConnectors: env("ENABLED_CONNECTORS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Platform[],

  // Decode QR codes found in images attached to detections we already surface
  // (bounded — never whole-video frame scanning). Opt-out with QR_DECODE=0.
  qrDecode: env("QR_DECODE", "1") !== "0",

  // Opt-in: automatically post an acknowledgement reply to new mentions.
  // Default OFF — we never post to a platform without explicit opt-in.
  autoAcknowledge: env("AUTO_ACKNOWLEDGE", "") === "1",

  // Opt-in: automatically link a mention to a wearer's code when exactly one
  // candidate code is present (see pipeline/autoresolve.ts). Default OFF — the
  // output is a sighting on a real person's dashboard, so ambiguity waits for
  // a human rather than guessing.
  autoResolve: env("AUTO_RESOLVE", "") === "1",

  // Hard cap on posts read per poll cycle, per connector. This is a COST
  // control: X bills per post returned, so one over-broad query is how this
  // gets expensive. Enforced on free platforms too — a runaway loop is the same
  // bug wherever it happens.
  maxReadsPerPoll: Math.max(1, Number(env("MAX_READS_PER_POLL", "200"))),

  db: {
    host: env("DB_HOST", "127.0.0.1"),
    port: Number(env("DB_PORT", "3306")),
    user: env("DB_USER"),
    password: env("DB_PASSWORD"),
    database: env("DB_NAME", "qrivacy_detection"),
  },

  // The qrivacy app's ingest API — the preferred way to write a sighting back.
  // Set both and the detector holds NO database credentials for qrivacy at all,
  // which is the point: it can then run on a different host, and it cannot skip
  // the screening/dedupe/notification rules that live above qrivacy's data layer.
  // Token is issued in qrivacy's admin panel at /admin/detectors.
  qrivacyApi: {
    baseUrl: env("QRIVACY_API_URL").replace(/\/$/, ""),
    token: env("QRIVACY_API_TOKEN"),
  },

  // The qrivacy app's OWN database — the LEGACY write path, kept only until the
  // API is proven against real traffic (see DEPLOY.md, "Cutting over"). Used only
  // when QRIVACY_API_* is unset. Optional either way: leave both blank to run
  // detection standalone (triage-only, no writeback).
  qrivacyDb: {
    host: env("QRIVACY_DB_HOST", env("DB_HOST", "127.0.0.1")),
    port: Number(env("QRIVACY_DB_PORT", env("DB_PORT", "3306"))),
    user: env("QRIVACY_DB_USER"),
    password: env("QRIVACY_DB_PASSWORD"),
    database: env("QRIVACY_DB_NAME", "qrivacy"),
  },

  // Bluesky reads need no credentials at all (the public AppView is open);
  // these are only needed to POST replies.
  bluesky: {
    handle: env("BLUESKY_HANDLE").replace(/^@/, ""),
    appPassword: env("BLUESKY_APP_PASSWORD"),
  },

  // Reddit needs a registered "script" app to read at all (unauthenticated
  // access is throttled or blocked). Client id/secret alone = search only;
  // adding the bot account's username/password unlocks the mentions inbox —
  // the only place a code link inside a COMMENT can be seen — and replies.
  reddit: {
    clientId: env("REDDIT_CLIENT_ID"),
    clientSecret: env("REDDIT_CLIENT_SECRET"),
    username: env("REDDIT_USERNAME").replace(/^\/?u\//, ""),
    password: env("REDDIT_PASSWORD"),
    // Reddit asks for "platform:app-id:version (by /u/name)" and rate-limits a
    // generic UA far harder. Blank = derived from the account name.
    userAgent: env("REDDIT_USER_AGENT"),
    // Subreddits we never comment in, lowercase, no "r/" prefix. Defaults are
    // the big general subs where an unsolicited bot comment is removed on sight
    // and counts against the account. Add any sub whose mods ask us to stop.
    skipSubreddits: list(
      "REDDIT_SKIP_SUBREDDITS",
      "askreddit,news,worldnews,politics,pics,funny,videos,todayilearned"
    ).map((s) => s.toLowerCase().replace(/^\/?r\//, "")),
    // Minimum spacing between Reddit API calls. The free tier allows 100
    // requests/minute per client, so 1.1s leaves an order of magnitude of head-
    // room. Tests set 0.
    minIntervalMs: Math.max(0, Number(env("REDDIT_MIN_INTERVAL_MS", "1100"))),
  },

  // Mastodon reads split in two, and the split is not the usual read/write one.
  // A token unlocks BOTH the mentions inbox (the reliable, federated half) and
  // full-text search; without one, only public hashtag timelines are readable.
  // Note that token-less status search is not merely weaker — it returns 200
  // with an empty list for every query, so it must never be attempted blind.
  mastodon: {
    baseUrl: env("MASTODON_BASE_URL", "https://mastodon.social"),
    // Bare local username, no @ and no instance — the inbox we read is on
    // MASTODON_BASE_URL by definition. Blank = fall back to WATCH_HANDLE.
    handle: env("MASTODON_HANDLE").replace(/^@/, ""),
    // Scopes needed: read:notifications + read:search, plus write:statuses only
    // if AUTO_ACKNOWLEDGE is ever turned on for this platform.
    accessToken: env("MASTODON_ACCESS_TOKEN"),
    // Optional public hashtag timelines, no credentials required. Off by
    // default: a hashtag is not our footprint, so anything found here is a
    // guess about relevance rather than a match on the handle or a code host.
    tags: list("MASTODON_TAGS", "").map((t) => t.replace(/^#/, "").toLowerCase()),
  },

  x: {
    bearerToken: env("X_BEARER_TOKEN"),
    mentionedUserId: env("X_MENTIONED_USER_ID"),
    // Posting a reply needs a USER-context token (app-only bearer can't write).
    userAccessToken: env("X_USER_ACCESS_TOKEN"),
  },
  instagram: {
    accessToken: env("IG_ACCESS_TOKEN"),
    businessAccountId: env("IG_BUSINESS_ACCOUNT_ID"),
    webhookVerifyToken: env("IG_WEBHOOK_VERIFY_TOKEN"),
  },
  facebook: {
    pageAccessToken: env("FB_PAGE_ACCESS_TOKEN"),
    pageId: env("FB_PAGE_ID"),
    webhookVerifyToken: env("FB_WEBHOOK_VERIFY_TOKEN"),
  },
  linkedin: {
    accessToken: env("LINKEDIN_ACCESS_TOKEN"),
    orgUrn: env("LINKEDIN_ORG_URN"),
  },
  tiktok: {
    clientKey: env("TIKTOK_CLIENT_KEY"),
    accessToken: env("TIKTOK_ACCESS_TOKEN"),
  },
};

/**
 * The full footprint each connector searches for — the handle AND every code
 * host — so we catch codes that appear without an @mention, on whatever domain.
 */
export function searchTerms(): string[] {
  const terms = [`@${config.watchHandle}`, ...config.codeHosts];
  return [...new Set(terms.filter(Boolean))];
}

export const dbConfigured = (): boolean =>
  Boolean(config.db.host && config.db.user && config.db.database);

export const qrivacyApiConfigured = (): boolean =>
  Boolean(config.qrivacyApi.baseUrl && config.qrivacyApi.token);

export const qrivacyDbConfigured = (): boolean =>
  Boolean(config.qrivacyDb.host && config.qrivacyDb.user && config.qrivacyDb.database);

/**
 * Can we write a sighting back to qrivacy at all, by either route?
 *
 * Callers deciding "should I attempt a writeback" must ask THIS, not
 * qrivacyDbConfigured(). Removing QRIVACY_DB_* after the API cutover is the
 * final step of the migration, and anything still gated on the database alone
 * would silently stop writing back at that moment — reporting success while
 * doing nothing, which is the worst available failure.
 */
export const qrivacyWritebackConfigured = (): boolean =>
  qrivacyApiConfigured() || qrivacyDbConfigured();
