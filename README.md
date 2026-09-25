# QRivacy detection — Reddit connector (review copy)

This is a **read-only public extract** of the Reddit half of QRivacy's detection
service, published so that Reddit — or anyone else assessing what this bot does —
can read the code behind the claims rather than take our word for them.

It is generated from a private repository by `bin/publish-review-extract.sh`.
Source commit: `387cbe1`. It is a subset: the deployment runbooks and server
configuration are not here, because they describe a machine rather than a
behaviour.

## What the bot is for

QRivacy gives out free QR codes: anyone can sign up for one at no cost, and
nobody has to buy anything. (Optional accessories such as phone cases and
stickers just make a code easier to show.) Someone who would rather not appear
in strangers' photos and videos displays theirs; a person who films them can scan it and
tell them, anonymously, where they turned up. This service watches for a
QRivacy code appearing online so the wearer finds out.

On Reddit it looks for three things and nothing else:

| Signal | Where it can be seen | Endpoint |
|---|---|---|
| a `u/qrivacyme` mention | posts (search) and comments (our inbox) | `/search`, `/message/mentions` |
| a link to a code — `qxa.me/<code>` | posts | `/search`, `/domain/<host>/new` |
| a QR code inside an image on a post we already surfaced | posts | decoded locally, no extra API call |

**There is no keyword search and there must never be one.** The bot does not
look for people talking about privacy, or filming, or anything else. It reacts
only to being named or to a wearer's own code being posted. That constraint is
in `src/pipeline/respond.ts` (`AUTO_REPLY_TRIGGERS`) with the reasoning next
to it.

## Posting: built, and switched off

The connector can post a comment. **It does not**, and our Data API application
says so. `AUTO_ACKNOWLEDGE` is unset in production, which is the default
(`src/config.ts`), and the Reddit connector is not in `ENABLED_CONNECTORS`
at all yet.

The reply code is published here rather than deleted because it is what we would
be asking permission for, and because a reviewer should be able to see exactly
what we would say. Turning it on is a re-application to Reddit, not a config
change.

If it is ever enabled, four gates stand between a detection and a public
comment, three of which a human operator cannot override:

| Gate | Implemented in | Human can override? |
|---|---|---|
| the mention is a real trigger (named us, or posted a code) | `src/pipeline/respond.ts` | yes — an operator may answer something the bot would not |
| the author has asked us to stop | `src/pipeline/optout.ts` | **no** |
| the subreddit is skip-listed, or is NSFW | `src/connectors/reddit.ts` → `mayReplyTo()` | **no** |
| we already commented in that thread | `src/connectors/reddit.ts` → `mayReplyTo()` | **no** |

**Opt-out is permanent and free.** "bad bot", "opt out", "leave me alone" and
similar are matched in `src/pipeline/optout.ts`, written to the
`reply_opt_outs` table (`db/schema.sql`), and checked before every reply,
across restarts. Every reply carries the bot disclosure and says so —
`src/pipeline/reply-text.ts`.

A refused reply is logged and left for a person to read. It is never marked
handled: "the bot should not say this" is usually the case where a human should.

## Rate and volume

- ~5–6 requests per poll cycle (one search, one listing per code host, two inbox
  listings), one cycle per minute — roughly **6 requests/minute**, against a free
  tier of 100.
- Calls are additionally spaced `REDDIT_MIN_INTERVAL_MS` apart (default 1100ms)
  in `src/connectors/reddit.ts` → `paced()`.
- A descriptive User-Agent in Reddit's requested `platform:app-id:version (by
  /u/name)` form is sent on every request — `userAgent()`, same file.
- Reads per cycle are hard-capped by `MAX_READS_PER_POLL`
  (`src/connectors/search.ts`), which logs loudly rather than truncating
  quietly.

## Deleted content is deleted here

`src/pipeline/redact.ts`, with the per-platform check in each connector's
`findDeleted()` and the full write-up in
`docs/deletion-and-retention.md`.

A sweep every six hours asks each platform which of our stored rows are gone and
strips those — the author, the text, the media and the raw payload. On Reddit
that is `/api/info` in batches of 100, matching on the `[deleted]` /
`[removed]` tombstones rather than on absence, because Reddit returns a
deleted thing rather than omitting it. Moderator removals are treated as
deletions too. A retention ceiling of 180 days applies to everything else
regardless of whether it still exists.

Rows are stripped rather than dropped: one may already have been reported to the
customer whose code was detected, and what remains carries no user content and no
author identity. Every uncertainty in that path resolves towards doing nothing —
a check that errors, or returns an empty batch, redacts nothing and waits for the
next sweep, because redaction cannot be undone.

## What is stored

`db/schema.sql`. One row per detection: the platform's own id, the author
handle, the text, the permalink, image URLs, the timestamp, and the raw payload
for audit. It is a work queue for a human, not a dataset — no profile building,
no bulk collection, no resale, and nothing is used to train a model.

## Tests

`test/reddit.test.ts` and `test/optout.test.ts` cover the etiquette gates,
the opt-out, the app-only vs user-context token split, and Reddit's
HTTP-200-with-an-errors-array behaviour. `npm test` in the private repo runs
107 tests across all connectors.

## Contact

<https://qrivacy.me> · the account is `u/qrivacyme`. Moderators: adding a
subreddit to the skip list takes one line and is never argued with.
