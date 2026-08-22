import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WATCH_HANDLE = "qrivacyme";
process.env.REDDIT_CLIENT_ID = "cid";
process.env.REDDIT_CLIENT_SECRET = "csec";
process.env.REDDIT_USERNAME = "qrivacyme";
process.env.REDDIT_PASSWORD = "hunter2";
process.env.REDDIT_MIN_INTERVAL_MS = "0";

import type { MentionRecord } from "../src/store/types.js";

/** A stored Reddit mention in a subreddit we're happy to reply in. */
function record(over: Partial<MentionRecord> = {}): MentionRecord {
  return {
    id: "1",
    platform: "reddit",
    externalId: "t1_x",
    authorHandle: "u/asker",
    authorDisplayName: null,
    text: "u/qrivacyme what do I do?",
    permalink: "https://www.reddit.com/r/privacy/comments/t1/x/",
    mediaUrls: [],
    postedAt: null,
    matchType: "handle_mention",
    extractedCodes: [],
    status: "new",
    linkedCode: null,
    linkedSightingId: null,
    discoveredAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    raw: { kind: "t1", data: { name: "t1_x", subreddit: "privacy", link_id: "t3_z" } },
    ...over,
  };
}

/** Accept any reply; record how many were actually posted. */
function stubReplies() {
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("access_token")) {
      return jsonRes({ access_token: "t", expires_in: 3600 });
    }
    sent.push(body);
    return jsonRes({ json: { errors: [], data: { things: [{ data: { name: "t1_r" } }] } } });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

function jsonRes(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    async text() { return JSON.stringify(body); },
  };
}

test("opt-out phrases are recognised, and near-misses are not", async () => {
  const { isOptOutRequest } = await import("../src/pipeline/optout.js");
  assert.equal(isOptOutRequest("bad bot"), true);
  assert.equal(isOptOutRequest("Please opt-out, thanks"), true);
  assert.equal(isOptOutRequest("don't reply to me again"), true);
  assert.equal(isOptOutRequest("leave me alone"), true);
  // Complaints are for a human to read, not grounds to silently mute someone.
  assert.equal(isOptOutRequest("this is wrong"), false);
  assert.equal(isOptOutRequest("the bad bottleneck here is search"), false);
});

test("an opt-out is recorded and permanently silences replies to that author", async () => {
  const { MemoryStore } = await import("../src/store/memory.js");
  const { setStore } = await import("../src/store/index.js");
  const { noteOptOutRequest } = await import("../src/pipeline/optout.js");
  const { acknowledge } = await import("../src/pipeline/respond.js");

  const store = new MemoryStore(false);
  setStore(store);
  const stub = stubReplies();

  try {
    await noteOptOutRequest(record({ text: "bad bot" }));
    assert.equal(await store.isOptedOut("reddit", "u/asker"), true);
    // Case-insensitive: u/Asker and u/asker are the same person.
    assert.equal(await store.isOptedOut("reddit", "u/ASKER"), true);

    const res = await acknowledge(record());
    assert.equal(res.ok, false);
    assert.match(res.skipped!, /opted out/);
    assert.equal(stub.sent.length, 0, "nothing was posted");

    // And a human pressing the button doesn't override it — it's a promise.
    const manual = await acknowledge(record(), { manual: true });
    assert.equal(manual.ok, false);
    assert.equal(stub.sent.length, 0);
  } finally {
    stub.restore();
  }
});

test("the bot never speaks unprompted, but a human can answer anything", async () => {
  const { MemoryStore } = await import("../src/store/memory.js");
  const { setStore } = await import("../src/store/index.js");
  const { acknowledge } = await import("../src/pipeline/respond.js");
  const { resetRedditAuth } = await import("../src/connectors/reddit.js");

  setStore(new MemoryStore(false));
  resetRedditAuth();
  const stub = stubReplies();

  try {
    // matchType=unknown is a post that never addressed us. Auto: silence.
    const auto = await acknowledge(record({ matchType: "unknown" }));
    assert.equal(auto.ok, false);
    assert.match(auto.skipped!, /not an auto-reply trigger/);
    assert.equal(stub.sent.length, 0);

    // The triage queue exists so a person can decide to answer it anyway.
    const manual = await acknowledge(record({ matchType: "unknown" }), { manual: true });
    assert.equal(manual.ok, true);
    assert.equal(stub.sent.length, 1);
  } finally {
    stub.restore();
  }
});

test("a summon gets the takedown steps; a code link gets the explainer", async () => {
  const { replyTextFor } = await import("../src/pipeline/reply-text.js");

  const summoned = replyTextFor(record());
  assert.match(summoned, /Save the evidence first/);
  assert.match(summoned, /privacy/i);
  assert.match(summoned, /qrivacy\.me\/guidance/);
  // The carve-out matters more than anything else in the reply.
  assert.match(summoned, /police/);
  // Bot disclosure and opt-out are what keep the account alive on Reddit.
  assert.match(summoned, /I'm a bot/);
  assert.match(summoned, /bad bot/);

  const spotted = replyTextFor(record({ matchType: "code_link" }));
  assert.match(spotted, /anonymously/);
  assert.match(spotted, /I'm a bot/);

  // Short platforms keep the 300-character form.
  const bsky = replyTextFor(record({ platform: "bluesky", authorHandle: "@x.bsky.social" }));
  assert.ok(bsky.length <= 300, `bluesky reply must fit 300 graphemes, got ${bsky.length}`);
});
