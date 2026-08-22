# Deletion propagation and retention

What happens to a stored mention when the person who posted it deletes it, and
what happens to one nobody deletes.

Code: `src/pipeline/redact.ts` · per-platform checks: `findDeleted()` in each
connector · schema: `db/migrations/004-add-redaction.sql`.

---

## Why this exists

Reddit's Developer Terms require that content deleted on Reddit is deleted by
you. **Nothing in this service did that until 2026-08-22.** A `mentions` row kept
its text and its full raw payload permanently, including for a post whose author
had removed it months earlier.

It was not only a Reddit problem. Bluesky was live and Mastodon merged with the
same gap, which is why the fix is one generic mechanism with a small per-platform
check rather than a Reddit feature.

It is also just right. Someone who deletes a post has withdrawn it. They did not
make an exception for the service that happened to be watching.

---

## Redaction is not deletion, and the difference is deliberate

A redacted row keeps its skeleton:

| Stripped | Kept |
|---|---|
| `author_handle`, `author_name` | `id`, `platform`, `external_id` |
| `text` | `discovered_at`, `posted_at`, `status` |
| `media_urls` | `linked_code`, `linked_sighting_id` |
| `raw` (the whole payload) | `permalink` |

**Why not just delete the row.** A sighting already delivered to a customer
points at it, and so does a `detection_reports` audit line on the qrivacy side.
Dropping the row would tear a hole in our own record that something happened, in
order to satisfy an obligation that is about *the author's content*. The two are
not the same thing, and conflating them loses the audit trail for no gain.

**Why `permalink` stays.** It is a locator, not content — and it is what makes a
sighting a customer already received still make sense to them. The content it
points at is gone; that is the platform's business, not ours to mirror.

**Why `linked_code` stays.** It is the customer's code. It is our data, not the
author's.

---

## The direction of failure is the whole design

Redaction is **irreversible**. There is no backup of a `raw` payload we
deliberately blanked. So every uncertainty in this path resolves towards doing
nothing:

- a connector with **no** `findDeleted` is reported as **unchecked**, never as
  clean — the log says `NOT CHECKED` and the one-shot script exits non-zero;
- a platform whose check **throws** aborts that platform and leaves its rows
  alone; the others still run;
- a batch that comes back **empty** is treated as *unknown*, not as "all of these
  are deleted". That guard lives in each connector, because only there is the
  response shape known well enough to tell a hiccup from an answer;
- a sweep that fails entirely simply happens again in six hours.

The cost of being too cautious is a deleted post lingering a few hours. The cost
of being too eager is the permanent erasure of an inbox that cannot be rebuilt.
Those are not comparable and the code does not pretend they are.

---

## What "gone" means, per platform

The three platforms disagree about this, and getting it wrong in either direction
is silent.

### Reddit — tombstones, not absence

`/api/info?id=…`, up to **100 fullnames per request**, which is why
`external_id` is stored as the fullname. Reddit does **not** drop a deleted thing
from the response; it returns it with the author and body replaced. So three
things count as gone:

- absent from the response entirely;
- `author` is `[deleted]`;
- `selftext` / `body` is `[deleted]` or `[removed]`.

**Checking only for absence would find almost nothing.** That is the trap here.

Moderator removal lands in the third case alongside author deletion and is
treated the same — stricter than Reddit asks for, deliberately. We would rather
drop a post a mod hid than keep one an author withdrew, and nothing downstream
needs the text of a removed post.

### Bluesky — absence is the signal

`app.bsky.feed.getPosts`, **25 URIs per call**, no credentials needed. It returns
only posts that still exist, so absence *is* the deletion signal — the exact
opposite of Reddit. Applying Reddit's logic here would find nothing; applying
Bluesky's logic to Reddit would find nothing.

### Mastodon — a real 404, one request at a time

`GET /api/v1/statuses/:id` answers **404** when the status is gone. No tombstone
to match, but also **no batch endpoint**, so this is one HTTP request per row and
the only connector whose sweep budget genuinely bites (`MAX_DELETION_CHECKS`,
60 per sweep).

⚠️ **The addressing trap.** `external_id` here is the **ActivityPub URI**, chosen
because it is identical on every instance holding a copy — and the REST API
cannot be addressed by it. The instance-local `id` is what `/api/v1/statuses/:id`
wants, and it exists only inside the payload we captured. That is why `raw` is
part of the `findDeleted` contract and not just the id.

Only a clean 404 counts. A 401, 429 or 5xx means *we do not know*, and the
connector throws rather than returning an empty answer — because if the token has
expired, every subsequent call fails identically and a loop that quietly checks
nothing for a thousand rows would report a clean sweep.

---

## The retention ceiling

`RETENTION_DAYS`, **default 180**, applied regardless of whether the post still
exists. This is what makes *"how long do you keep it?"* answerable with a number.

It is **on by default**, unlike almost everything else here. A retention ceiling
that has to be switched on is one that is off on every deployment where nobody
thought about it — which is exactly the deployment that ends up holding five
years of other people's deleted posts. `RETENTION_DAYS=0` disables it, and the
sweep then warns on every single run, because that is a choice someone should
have to own.

A retention pass never relabels a row already redacted as `deleted_upstream`.
The two reasons answer different questions from different people: one is the
evidence that we honour deletions, the other that we do not hoard.

---

## Operating it

Runs automatically every 6 hours (`REDACTION_INTERVAL_MS`), first run five
minutes after start — startup is when the poll cycle, the DB connection and every
connector's first auth all happen at once, and this is the one job that cannot be
replayed if it goes wrong on a half-initialised process.

By hand, same code path:

```bash
npm run redact
```

**It exits non-zero if any platform could not be checked**, which is the point:
"nothing was deleted" and "nothing was looked at" produce the same count
otherwise, and only one of them is a compliance problem. Suitable for cron mail.

What a healthy run looks like:

```
[redact] bluesky: 200 checked, 3 gone upstream
[redact] reddit: 200 checked, 0 gone upstream
[redact] retention (180d): 12 stripped
```

What a problem looks like — and note it is a **warning**, not a silent zero:

```
[redact] mastodon: NOT CHECKED — mastodon: request failed 401 …
```

To see what has been stripped and why:

```sql
SELECT redacted_reason, COUNT(*), MIN(redacted_at), MAX(redacted_at)
  FROM mentions WHERE redacted_at IS NOT NULL GROUP BY redacted_reason;
```

And to find rows nothing has ever asked about — the number that should be
falling, not growing:

```sql
SELECT platform, COUNT(*) FROM mentions
 WHERE redacted_at IS NULL AND last_checked_at IS NULL GROUP BY platform;
```

---

## Adding a platform

A connector without `findDeleted` is **not** a connector that has nothing to
delete — it is one whose rows are never checked, and the sweep says so on every
run. Implement it at the same time as `poll()`, and read the contract note on
`Connector.findDeleted` first: it answers *"confirmed gone"*, never *"not
confirmed present"*, and `[]` is always a safe answer.
