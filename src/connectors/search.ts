/**
 * The shared "footprint search" driver.
 *
 * Every polling platform does the same four things: turn the footprint terms
 * (the @handle AND every code host) into queries, run them, normalise the hits,
 * and move a cursor forward. Only the query syntax and the response shape are
 * platform-specific, so those are the only things a connector supplies here.
 *
 * Two behaviours are deliberately centralised rather than left to connectors:
 *
 *   - **Dedupe across queries.** Searching "@qrivacyme" and "qxa.me" separately
 *     will return the same post twice when someone does both. Ingest is already
 *     idempotent, but deduping here keeps the read budget honest and stops one
 *     post being counted twice against it.
 *   - **The read budget.** X bills per post *returned*, not per call, so a
 *     single over-broad query is the way this gets expensive. The cap is
 *     enforced for every platform (free ones included) because the failure mode
 *     — a runaway loop against a paid API — is the same shape everywhere.
 */
import type { NormalizedMention, Platform, PollResult } from "./types.js";

export interface FootprintSearchSpec<TItem> {
  platform: Platform;
  /** Footprint terms: the @handle plus every configured code host. */
  terms: string[];

  /**
   * Turn the terms into the queries to actually run. X folds them all into one
   * OR-query (one call, cheapest); Bluesky has no reliable OR, so it runs one
   * query per term. Return [] to skip the cycle entirely.
   */
  toQueries(terms: string[]): string[];

  /** Run one query and return the raw platform items. */
  fetchPage(query: string, cursor: string | null): Promise<TItem[]>;

  /** Raw item -> normalised mention. Return null to drop it silently. */
  normalize(item: TItem): NormalizedMention | null;

  /**
   * Keep only genuinely-new mentions. Platforms with a server-side "since"
   * (X's since_id) can omit this; those without (Bluesky) filter client-side.
   */
  isNew?(m: NormalizedMention, cursor: string | null): boolean;

  /** The cursor to persist, given everything seen this cycle. */
  advanceCursor(seen: NormalizedMention[], cursor: string | null): string | null;

  /** Hard cap on posts read per cycle. See the read-budget note above. */
  maxReads: number;
}

export async function runFootprintSearch<TItem>(
  spec: FootprintSearchSpec<TItem>,
  cursor: string | null
): Promise<PollResult> {
  const queries = spec.toQueries(spec.terms);
  if (!queries.length) return { mentions: [], cursor };

  const seen = new Map<string, NormalizedMention>();
  let reads = 0;
  let capped = false;

  for (const query of queries) {
    if (reads >= spec.maxReads) {
      capped = true;
      break;
    }
    const items = await spec.fetchPage(query, cursor);

    for (const item of items) {
      // Every returned post counts against the budget even if we discard it —
      // on a per-read biller we have already paid for it by this point.
      reads += 1;
      if (reads > spec.maxReads) {
        capped = true;
        break;
      }
      const m = spec.normalize(item);
      if (!m) continue;
      if (!seen.has(m.externalId)) seen.set(m.externalId, m);
    }
  }

  const all = [...seen.values()];
  const fresh = spec.isNew ? all.filter((m) => spec.isNew!(m, cursor)) : all;

  if (capped) {
    // Never silent: a truncated cycle that looks like a quiet one is how a
    // backlog goes unnoticed. The cursor still advances over what we did read.
    console.warn(
      `[search] ${spec.platform}: hit the ${spec.maxReads}-read cap; ` +
        `${queries.length} queries, results truncated — raise MAX_READS_PER_POLL or poll more often`
    );
  }

  return {
    mentions: fresh,
    // Advance over everything read, not just what survived isNew — otherwise a
    // cycle of all-old posts would rewind and re-read them forever.
    cursor: spec.advanceCursor(all, cursor),
  };
}
