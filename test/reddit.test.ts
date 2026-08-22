import { test } from "node:test";
import assert from "node:assert/strict";

// Env must be set BEFORE config is imported (each test dynamic-imports).
process.env.WATCH_HANDLE = "qrivacyme";
process.env.CODE_LINK_PREFIXES = "qxa.me/,qrivacy.me/r/";
process.env.REDDIT_CLIENT_ID = "cid";
process.env.REDDIT_CLIENT_SECRET = "csec";
process.env.REDDIT_USERNAME = "qrivacyme";
process.env.REDDIT_PASSWORD = "hunter2";
process.env.REDDIT_SKIP_SUBREDDITS = "askreddit,news";
// No pacing in tests, or every case pays 1.1s per API call.
process.env.REDDIT_MIN_INTERVAL_MS = "0";

interface StubThing {
  kind: string;
  data: Record<string, unknown>;
}

/**
 * Stub Reddit: the token endpoint plus one listing per source. `thingsFor` is
 * keyed by the path we asked for, so a test can assert which surfaces were hit.
 */
function stubReddit(thingsFor: (path: string, params: URLSearchParams) => StubThing[]) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/v1/access_token") {
      calls.push(`token:${String(init?.body ?? "")}`);
      return json({ access_token: "tok", expires_in: 3600 });
    }
    calls.push(u.pathname);
    return json({ data: { children: thingsFor(u.pathname, u.searchParams) } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() { return JSON.stringify(body); },
  };
}

const post = (over: Record<string, unknown> = {}): StubThing => ({
  kind: "t3",
  data: {
    id: "abc123",
    name: "t3_abc123",
    author: "someone",
    title: "found a weird QR pin at a gig",
    selftext: "the tag says https://qxa.me/7k2m9",
    url: "https://i.redd.it/pin.jpg",
    permalink: "/r/mildlyinteresting/comments/abc123/found_a_weird_qr_pin/",
    subreddit: "mildlyinteresting",
    created_utc: 1_780_000_000,
    ...over,
  },
});

const comment = (over: Record<string, unknown> = {}): StubThing => ({
  kind: "t1",
  data: {
    id: "cmt1",
    name: "t1_cmt1",
    author: "asker",
    body: "u/qrivacyme what do I do about this?",
    link_id: "t3_thread1",
    context: "/r/privacy/comments/thread1/help/cmt1/",
    subreddit: "privacy",
    created_utc: 1_780_000_500,
    ...over,
  },
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test("normalizes a link post: fullname id, u/ handle, url folded into the text", async () => {
  const { normalizeThing } = await import("../src/connectors/reddit.js");
  const m = normalizeThing(post() as never)!;

  assert.equal(m.platform, "reddit");
  assert.equal(m.externalId, "t3_abc123", "the fullname is the dedupe key AND the reply target");
  assert.equal(m.authorHandle, "u/someone");
  assert.match(m.text, /qxa\.me\/7k2m9/);
  assert.equal(
    m.permalink,
    "https://www.reddit.com/r/mildlyinteresting/comments/abc123/found_a_weird_qr_pin/"
  );
  assert.deepEqual(m.mediaUrls, ["https://i.redd.it/pin.jpg"]);
  assert.equal(m.postedAt, new Date(1_780_000_000_000).toISOString());
});

test("a link POST to a code host is a detection even with nothing in the title", async () => {
  const { normalizeThing } = await import("../src/connectors/reddit.js");
  const { classifyMatch } = await import("../src/pipeline/resolve.js");
  const m = normalizeThing(
    post({ title: "look at this", selftext: "", url: "https://qxa.me/9M4X2" }) as never
  )!;
  // The code lives ONLY in the url field of a link post — if textOf() dropped
  // it, this whole class of detection would silently classify as "unknown".
  assert.equal(classifyMatch(m.text, []), "code_link");
});

test("u/qrivacyme in a comment counts as a summon (Reddit spells mentions without @)", async () => {
  const { normalizeThing } = await import("../src/connectors/reddit.js");
  const { classifyMatch } = await import("../src/pipeline/resolve.js");
  const m = normalizeThing(comment() as never)!;
  assert.equal(classifyMatch(m.text, []), "handle_mention");
  assert.equal(classifyMatch("thanks /u/qrivacyme", []), "handle_mention");
  assert.equal(classifyMatch("u/qrivacymeXYZ is someone else", []), "unknown");
});

test("drops deleted authors and — critically — our own account", async () => {
  const { normalizeThing } = await import("../src/connectors/reddit.js");
  assert.equal(normalizeThing(post({ author: "[deleted]" }) as never), null);
  // Ingesting our own comment would let the bot reply to itself, forever.
  assert.equal(normalizeThing(comment({ author: "qrivacyme" }) as never), null);
  assert.equal(normalizeThing(comment({ author: "QRivacyMe" }) as never), null);
});

test("gallery and preview images are collected for QR decoding", async () => {
  const { mediaOf } = await import("../src/connectors/reddit.js");
  const urls = mediaOf({
    preview: { images: [{ source: { url: "https://preview.redd.it/a.jpg?s=sig" } }] },
    media_metadata: { k1: { s: { u: "https://preview.redd.it/b.jpg?s=sig" } } },
  } as never);
  assert.deepEqual(urls, [
    "https://preview.redd.it/a.jpg?s=sig",
    "https://preview.redd.it/b.jpg?s=sig",
  ]);
});

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

test("the @handle footprint term is rewritten to Reddit's u/ spelling", async () => {
  const { buildQuery } = await import("../src/connectors/reddit.js");
  const q = buildQuery(["@qrivacyme", "qxa.me", "qrivacy.me"], "qrivacyme");
  assert.equal(q, `"u/qrivacyme" OR "qxa.me" OR "qrivacy.me"`);
  assert.doesNotMatch(q, /@/, "an @handle query on Reddit matches nothing");
});

test("sources cover search + every code domain, and the inbox only with an account", async () => {
  const { sourcesFor } = await import("../src/connectors/reddit.js");
  const terms = ["@qrivacyme", "qxa.me", "qrivacy.me"];

  const withAccount = sourcesFor(terms, "qrivacyme", true);
  assert.ok(withAccount.some((s) => s.startsWith("search:")));
  assert.ok(withAccount.includes("domain:qxa.me"));
  assert.ok(withAccount.includes("domain:qrivacy.me"));
  // The inbox is the ONLY way a comment ever reaches us — no site-wide comment
  // search exists — so losing it silently halves the connector's coverage.
  assert.ok(withAccount.includes("inbox:mentions"));

  const readOnly = sourcesFor(terms, "qrivacyme", false);
  assert.ok(!readOnly.some((s) => s.startsWith("inbox:")));
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

test("poll hits search, domain and inbox, dedupes across them, and advances the cursor", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();

  // The same post comes back from search AND the domain listing — the overlap
  // the shared driver exists to collapse.
  const stub = stubReddit((path) => {
    if (path === "/search") return [post()];
    if (path.startsWith("/domain/qxa.me")) return [post()];
    if (path === "/message/mentions") return [comment()];
    return [];
  });

  try {
    const res = await redditConnector.poll!(null);
    assert.equal(res.mentions.length, 2, "one post + one comment, deduped");
    assert.equal(res.cursor, "1780000500", "cursor = newest created_utc seen");

    assert.ok(stub.calls.some((c) => c.startsWith("token:grant_type=password")));
    assert.ok(stub.calls.includes("/search"));
    assert.ok(stub.calls.includes("/domain/qxa.me/new"));
    assert.ok(stub.calls.includes("/message/mentions"));
  } finally {
    stub.restore();
  }
});

test("a cursor filters out items already seen, and never rewinds", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const stub = stubReddit((path) => (path === "/search" ? [post()] : []));
  try {
    const res = await redditConnector.poll!("1780000001");
    assert.equal(res.mentions.length, 0, "older than the cursor");
    assert.equal(res.cursor, "1780000001", "cursor holds rather than moving back");
  } finally {
    stub.restore();
  }
});

test("raw_json=1 is always sent — without it every image URL comes back escaped", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const seen: URLSearchParams[] = [];
  const stub = stubReddit((path, params) => {
    if (path === "/search") seen.push(params);
    return [];
  });
  try {
    await redditConnector.poll!(null);
    assert.equal(seen[0].get("raw_json"), "1");
    assert.equal(seen[0].get("include_over_18"), "on", "NSFW is read, just never replied to");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// The etiquette gate
// ---------------------------------------------------------------------------

async function gateFor(thing: StubThing) {
  const { redditConnector, normalizeThing } = await import("../src/connectors/reddit.js");
  return redditConnector.mayReplyTo!(normalizeThing(thing as never)!);
}

test("no replies in skip-listed subreddits or NSFW threads", async () => {
  const { MemoryStore } = await import("../src/store/memory.js");
  const { setStore } = await import("../src/store/index.js");
  setStore(new MemoryStore(false));

  const skipped = await gateFor(post({ subreddit: "AskReddit" }));
  assert.equal(skipped.ok, false);

  const nsfw = await gateFor(post({ over_18: true, subreddit: "somewhere" }));
  assert.equal(nsfw.ok, false);

  const fine = await gateFor(post());
  assert.equal(fine.ok, true);
});

test("never comments twice in the same thread", async () => {
  const { MemoryStore } = await import("../src/store/memory.js");
  const { setStore } = await import("../src/store/index.js");
  const { normalizeThing } = await import("../src/connectors/reddit.js");
  const store = new MemoryStore(false);
  setStore(store);

  // We already answered the post; a comment quoting the same link arrives.
  const { record } = await store.insert(normalizeThing(post() as never)!);
  await store.update(record.id, { status: "responded" });

  const sameThread = await gateFor(
    comment({ link_id: "t3_abc123", subreddit: "mildlyinteresting", author: "bystander" })
  );
  assert.equal(sameThread.ok, false, "two identical bot comments in one thread is spam");

  const otherThread = await gateFor(comment({ link_id: "t3_other", author: "bystander" }));
  assert.equal(otherThread.ok, true);
});

// ---------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------

test("a 200 carrying an errors array is a FAILED reply, not a sent one", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 3600 });
    // Reddit's real shape for "you are doing that too much".
    return json({ json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] } });
  }) as unknown as typeof fetch;

  try {
    const res = await redditConnector.reply!(
      { platform: "reddit", externalId: "t3_abc123" } as never,
      "hello"
    );
    assert.equal(res.ok, false, "HTTP 200 does not mean the comment posted");
    assert.match(res.error!, /RATELIMIT/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a successful reply returns the new comment's fullname", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const real = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 3600 });
    body = String(init?.body ?? "");
    return json({ json: { errors: [], data: { things: [{ data: { name: "t1_new" } }] } } });
  }) as unknown as typeof fetch;

  try {
    const res = await redditConnector.reply!(
      { platform: "reddit", externalId: "t3_abc123" } as never,
      "hello"
    );
    assert.equal(res.ok, true);
    assert.equal(res.externalId, "t1_new");
    // Form-encoded, not JSON: Reddit's write API silently no-ops on JSON.
    assert.match(body, /thing_id=t3_abc123/);
    assert.match(body, /api_type=json/);
  } finally {
    globalThis.fetch = real;
  }
});
