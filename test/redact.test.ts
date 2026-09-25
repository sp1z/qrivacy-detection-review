import { test } from "node:test";
import assert from "node:assert/strict";

// Env must be set BEFORE config is imported (each test dynamic-imports).
process.env.WATCH_HANDLE = "qrivacyme";
process.env.CODE_LINK_PREFIXES = "qxa.me/,qrivacy.me/r/";
process.env.REDDIT_CLIENT_ID = "cid";
process.env.REDDIT_CLIENT_SECRET = "csec";
process.env.REDDIT_USERNAME = "qrivacyme";
process.env.REDDIT_PASSWORD = "hunter2";
process.env.REDDIT_MIN_INTERVAL_MS = "0";
process.env.MASTODON_ACCESS_TOKEN = "mtok";
process.env.MASTODON_BASE_URL = "https://mastodon.social";
process.env.ENABLED_CONNECTORS = "bluesky,reddit,mastodon";

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() { return JSON.stringify(body); },
  };
}

function stubFetch(handler: (u: URL) => unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => handler(new URL(String(url)))) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

// ---------------------------------------------------------------------------
// Reddit — the tombstone cases, which are the ones absence-checking would miss
// ---------------------------------------------------------------------------

test("reddit.findDeleted catches absence, a deleted author and a removed body", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();

  const restore = stubFetch((u) => {
    if (u.pathname === "/api/v1/access_token") return json({ access_token: "t", expires_in: 3600 });
    return json({
      data: {
        children: [
          // alive
          { kind: "t3", data: { name: "t3_alive", author: "someone", selftext: "still here" } },
          // author deleted their account/post — Reddit leaves a tombstone
          { kind: "t3", data: { name: "t3_authorgone", author: "[deleted]", selftext: "text" } },
          // body removed by a moderator
          { kind: "t1", data: { name: "t1_bodygone", author: "someone", body: "[removed]" } },
          // t3_missing is simply not returned
        ],
      },
    });
  });

  const gone = await redditConnector.findDeleted!([
    { externalId: "t3_alive", raw: null },
    { externalId: "t3_authorgone", raw: null },
    { externalId: "t1_bodygone", raw: null },
    { externalId: "t3_missing", raw: null },
  ]);
  restore();

  assert.deepEqual(gone.sort(), ["t1_bodygone", "t3_authorgone", "t3_missing"]);
});

test("reddit.findDeleted treats an EMPTY response as unknown, never as all-deleted", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();

  const restore = stubFetch((u) => {
    if (u.pathname === "/api/v1/access_token") return json({ access_token: "t", expires_in: 3600 });
    return json({ data: { children: [] } }); // what a hiccup looks like
  });

  const gone = await redditConnector.findDeleted!([
    { externalId: "t3_a", raw: null },
    { externalId: "t3_b", raw: null },
  ]);
  restore();

  // The dangerous answer here is ["t3_a","t3_b"] — irreversible erasure of rows
  // that are probably fine.
  assert.deepEqual(gone, []);
});

test("reddit.findDeleted ignores externalIds that are not fullnames", async () => {
  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  let asked = false;
  const restore = stubFetch((u) => {
    if (u.pathname === "/api/v1/access_token") return json({ access_token: "t", expires_in: 3600 });
    asked = true;
    return json({ data: { children: [] } });
  });
  const gone = await redditConnector.findDeleted!([{ externalId: "not-a-fullname", raw: null }]);
  restore();
  assert.deepEqual(gone, []);
  assert.equal(asked, false, "should not call the API with nothing addressable");
});

// ---------------------------------------------------------------------------
// Bluesky — absence IS the signal here, unlike Reddit
// ---------------------------------------------------------------------------

test("bluesky.findDeleted reports URIs missing from getPosts", async () => {
  const { blueskyConnector } = await import("../src/connectors/bluesky.js");
  const restore = stubFetch(() =>
    json({ posts: [{ uri: "at://did:plc:x/app.bsky.feed.post/alive" }] })
  );
  const gone = await blueskyConnector.findDeleted!([
    { externalId: "at://did:plc:x/app.bsky.feed.post/alive", raw: null },
    { externalId: "at://did:plc:x/app.bsky.feed.post/gone", raw: null },
  ]);
  restore();
  assert.deepEqual(gone, ["at://did:plc:x/app.bsky.feed.post/gone"]);
});

test("bluesky.findDeleted treats an empty posts array as unknown", async () => {
  const { blueskyConnector } = await import("../src/connectors/bluesky.js");
  const restore = stubFetch(() => json({ posts: [] }));
  const gone = await blueskyConnector.findDeleted!([
    { externalId: "at://did:plc:x/app.bsky.feed.post/a", raw: null },
  ]);
  restore();
  assert.deepEqual(gone, []);
});

// ---------------------------------------------------------------------------
// Mastodon — 404 means gone; anything else means we do not know
// ---------------------------------------------------------------------------

test("mastodon.findDeleted treats 404 as deleted and uses the LOCAL id, not the AP uri", async () => {
  const { mastodonConnector } = await import("../src/connectors/mastodon.js");
  const paths: string[] = [];
  const restore = stubFetch((u) => {
    paths.push(u.pathname);
    return u.pathname.endsWith("/999") ? json({ error: "Record not found" }, 404) : json({ id: "111" });
  });
  const gone = await mastodonConnector.findDeleted!([
    { externalId: "https://mastodon.social/users/a/statuses/111", raw: { id: "111" } },
    { externalId: "https://mastodon.social/users/a/statuses/999", raw: { id: "999" } },
  ]);
  restore();

  assert.deepEqual(gone, ["https://mastodon.social/users/a/statuses/999"]);
  // Addressed by local id — the AP uri is not a REST address.
  assert.deepEqual(paths, ["/api/v1/statuses/111", "/api/v1/statuses/999"]);
});

test("mastodon.findDeleted throws on a non-404 rather than redacting", async () => {
  const { mastodonConnector } = await import("../src/connectors/mastodon.js");
  const restore = stubFetch(() => json({ error: "The access token is invalid" }, 401));
  await assert.rejects(
    () => mastodonConnector.findDeleted!([{ externalId: "u", raw: { id: "1" } }]),
    /401/
  );
  restore();
});

test("mastodon.findDeleted skips rows with no local id instead of guessing", async () => {
  const { mastodonConnector } = await import("../src/connectors/mastodon.js");
  let called = false;
  const restore = stubFetch(() => { called = true; return json({}); });
  const gone = await mastodonConnector.findDeleted!([{ externalId: "u", raw: {} }]);
  restore();
  assert.deepEqual(gone, []);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

async function freshStore() {
  const { MemoryStore } = await import("../src/store/memory.js");
  const { setStore } = await import("../src/store/index.js");
  const store = new MemoryStore(false); // unseeded
  setStore(store);
  return store;
}

const mention = (over: Record<string, unknown> = {}) => ({
  platform: "reddit" as const,
  externalId: "t3_one",
  authorHandle: "u/someone",
  authorDisplayName: "Someone",
  text: "a post mentioning qxa.me/7k2m9",
  permalink: "https://reddit.com/r/x/comments/one/",
  mediaUrls: ["https://i.redd.it/a.jpg"],
  postedAt: "2026-08-01T00:00:00.000Z",
  raw: { kind: "t3", data: { name: "t3_one" } },
  ...over,
});

test("redact strips the author and their content, and keeps our own record", async () => {
  const store = await freshStore();
  const { record } = await store.insert(mention());
  await store.update(record.id, { status: "linked", linkedCode: "7K2M9", linkedSightingId: 35 });

  const n = await store.redact([record.id], "deleted_upstream");
  assert.equal(n, 1);

  const after = await store.get(record.id);
  assert.ok(after);
  // Gone: everything that is the author's.
  assert.equal(after!.authorHandle, null);
  assert.equal(after!.authorDisplayName, null);
  assert.equal(after!.text, "");
  assert.deepEqual(after!.mediaUrls, []);
  assert.equal(after!.raw, null);
  // Kept: our record that a detection happened, and what it resolved to.
  assert.equal(after!.externalId, "t3_one");
  assert.equal(after!.linkedCode, "7K2M9");
  assert.equal(after!.linkedSightingId, 35);
  assert.equal(after!.status, "linked");
  assert.equal(after!.redactedReason, "deleted_upstream");
  assert.ok(after!.redactedAt);
});

test("redact is idempotent — a second pass changes nothing", async () => {
  const store = await freshStore();
  const { record } = await store.insert(mention());
  assert.equal(await store.redact([record.id], "deleted_upstream"), 1);
  assert.equal(await store.redact([record.id], "retention"), 0);
  const after = await store.get(record.id);
  // The original reason survives — a retention pass must not relabel evidence
  // that we honoured a deletion.
  assert.equal(after!.redactedReason, "deleted_upstream");
});

test("dueForDeletionCheck puts never-checked rows first, then least-recent, and skips redacted", async () => {
  const store = await freshStore();
  const a = (await store.insert(mention({ externalId: "t3_a" }))).record;
  const b = (await store.insert(mention({ externalId: "t3_b" }))).record;
  const c = (await store.insert(mention({ externalId: "t3_c" }))).record;

  await store.markChecked([a.id, b.id]); // a and b now have a timestamp; c has none
  await store.redact([b.id], "retention");

  const due = await store.dueForDeletionCheck("reddit", 10);
  assert.deepEqual(due.map((m) => m.externalId), ["t3_c", "t3_a"]);
});

test("olderThan finds rows past the ceiling and ignores fresh ones", async () => {
  const store = await freshStore();
  await store.insert(mention({ externalId: "t3_old", postedAt: "2020-01-01T00:00:00.000Z" }));
  await store.insert(mention({ externalId: "t3_new", postedAt: new Date().toISOString() }));
  const old = await store.olderThan(180, 10);
  assert.deepEqual(old.map((m) => m.externalId), ["t3_old"]);
});

// ---------------------------------------------------------------------------
// The sweep — the failure directions matter more than the happy path
// ---------------------------------------------------------------------------

test("sweepPlatform marks EVERYTHING it asked about as checked, not just the deleted", async () => {
  const store = await freshStore();
  const alive = (await store.insert(mention({ externalId: "t3_alive" }))).record;
  const dead = (await store.insert(mention({ externalId: "t3_dead" }))).record;

  const { redditConnector, resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const restore = stubFetch((u) => {
    if (u.pathname === "/api/v1/access_token") return json({ access_token: "t", expires_in: 3600 });
    return json({
      data: { children: [{ kind: "t3", data: { name: "t3_alive", author: "x", selftext: "y" } }] },
    });
  });

  const { sweepPlatform } = await import("../src/pipeline/redact.js");
  const result = await sweepPlatform("reddit", 100);
  restore();

  assert.equal(result.checked, 2);
  assert.equal(result.redacted, 1);
  // The survivor must carry a fresh timestamp, or it sorts to the front for ever
  // and the sweep re-checks the same rows while the table is never covered.
  assert.ok((await store.get(alive.id))!.lastCheckedAt, "survivor was not marked checked");
  assert.ok((await store.get(dead.id))!.redactedAt);
  void redditConnector;
});

test("a connector with no deletion check is reported as UNCHECKED, never as clean", async () => {
  await freshStore();
  const { sweepPlatform } = await import("../src/pipeline/redact.js");
  // linkedin is a stub with no findDeleted implementation. This used to name
  // `x`, which gained one on 2026-08-22 — if this line ever has to change
  // again, check the replacement is genuinely check-less rather than merely
  // unconfigured, or the assertion below passes for the wrong reason
  // ("not configured" is a different skip message).
  const result = await sweepPlatform("linkedin", 100);
  assert.equal(result.checked, 0);
  assert.equal(result.redacted, 0);
  assert.match(result.skipped ?? "", /no deletion check/);
});

test("a platform whose check throws is skipped with the reason, and the sweep continues", async () => {
  const store = await freshStore();
  const rec = (await store.insert(mention({ externalId: "t3_x" }))).record;

  const { resetRedditAuth } = await import("../src/connectors/reddit.js");
  resetRedditAuth();
  const restore = stubFetch(() => json({ error: "server_error" }, 500));

  const { runRedactionSweep } = await import("../src/pipeline/redact.js");
  const report = await runRedactionSweep();
  restore();

  const reddit = report.platforms.find((p) => p.platform === "reddit");
  assert.ok(reddit?.skipped, "a throwing platform must be recorded as skipped");
  // And crucially: nothing was redacted on the strength of a failed check.
  assert.equal((await store.get(rec.id))!.redactedAt, null);
});

test("sweepRetention is a no-op when the ceiling is disabled", async () => {
  const store = await freshStore();
  await store.insert(mention({ externalId: "t3_ancient", postedAt: "2019-01-01T00:00:00.000Z" }));
  const { sweepRetention } = await import("../src/pipeline/redact.js");
  assert.equal(await sweepRetention(0, 100), 0);
  assert.equal(await sweepRetention(180, 100), 1);
});
