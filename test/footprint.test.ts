import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCandidates, classifyMatch, codesFrom } from "../src/pipeline/resolve.js";
import { buildQuery } from "../src/connectors/x.js";

// The domain has forked to qxa.me with the code at the ROOT (qxa.me/<code>),
// alongside the legacy qrivacy.me/r/<code>. Each keeps its own scheme.
const PREFIXES = ["qxa.me/", "qrivacy.me/r/"];

test("resolves a code from the new root-path short domain (qxa.me/<code>)", () => {
  const r = resolveCandidates("neat, https://qxa.me/9m4x2", { prefixes: PREFIXES });
  assert.deepEqual(r.codes, ["9M4X2"]);
});

test("caps-insensitive: HTTPS://QXA.ME/ABC123 still resolves", () => {
  const r = resolveCandidates("HTTPS://QXA.ME/ABC123", { prefixes: PREFIXES });
  assert.deepEqual(r.codes, ["ABC123"]);
});

test("still resolves the legacy qrivacy.me/r/ form", () => {
  const r = resolveCandidates("qrivacy.me/r/7k2m9", { prefixes: PREFIXES });
  assert.deepEqual(r.codes, ["7K2M9"]);
});

test("does NOT read a non-code path on a /r/-scheme host as a code", () => {
  // qrivacy.me uses /r/, so qrivacy.me/about must not yield code "about".
  const r = resolveCandidates("visit qrivacy.me/about for info", { prefixes: PREFIXES });
  assert.deepEqual(r.codes, []);
});

test("does not treat a code host as an external source URL", () => {
  const r = resolveCandidates("https://qxa.me/zzz9 and https://elsewhere.com/x", {
    prefixes: PREFIXES,
  });
  assert.deepEqual(r.codes, ["ZZZ9"]);
  assert.deepEqual(r.urls, ["https://elsewhere.com/x"]);
});

test("classifyMatch: QR beats link beats handle", () => {
  assert.equal(classifyMatch("has qxa.me/aaa9", ["fromqr"], { prefixes: PREFIXES }), "qr_image");
  assert.equal(classifyMatch("has qxa.me/aaa9", [], { prefixes: PREFIXES }), "code_link");
  assert.equal(classifyMatch("hey @qrivacyme", [], { prefixes: PREFIXES, watchHandle: "qrivacyme" }), "handle_mention");
  assert.equal(classifyMatch("just a normal post", [], { prefixes: PREFIXES }), "unknown");
});

test("codesFrom extracts a code out of a decoded QR payload string", () => {
  assert.deepEqual(codesFrom("https://qxa.me/QR9x8", { prefixes: PREFIXES }), ["QR9X8"]);
});

test("buildQuery ORs the footprint terms and excludes retweets", () => {
  const q = buildQuery(["@qrivacyme", "qr.vcy"]);
  assert.match(q, /@qrivacyme OR "qr\.vcy"/);
  assert.match(q, /-is:retweet/);
});
