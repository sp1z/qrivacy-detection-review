import { config } from "../config.js";
import { connectorFor, enabledConnectors } from "../connectors/index.js";
import type { Platform } from "../connectors/types.js";
import { getStore } from "../store/index.js";

/**
 * Honouring deletion, and not hoarding.
 *
 * Two obligations, deliberately in one file because they are the same operation
 * with different triggers:
 *
 *   1. **Deletion propagation.** Someone deletes their post; our copy has to go
 *      too. Reddit's Developer Terms require it in writing, and it is the right
 *      behaviour on every platform — a person who withdrew something did not
 *      make an exception for us. Nothing in this service did it until now: a row
 *      kept its text and its raw payload for ever, including for a post that had
 *      been gone for months.
 *   2. **A retention ceiling.** Content nobody deleted still should not sit here
 *      indefinitely. This is what makes "how long do you keep it?" answerable
 *      with a number instead of a shrug.
 *
 * WHAT REDACTION IS. Not row deletion. The author's identity, their words, their
 * media and the raw payload are stripped; the row's id, its platform, its
 * timestamps, its triage status and the qrivacy code it was linked to remain. A
 * sighting already delivered to a customer points at this row, and so does a
 * `detection_reports` audit line on the qrivacy side. Dropping the row would
 * tear a hole in our record that something happened, in order to satisfy an
 * obligation that is about the author's content — not about our own history.
 *
 * THE DIRECTION OF FAILURE IS THE WHOLE DESIGN. Redaction is irreversible: there
 * is no backup of a `raw` payload we deliberately blanked. So every uncertainty
 * in this path resolves towards *doing nothing*:
 *
 *   - a connector with no `findDeleted` is reported as unchecked, never as clean;
 *   - a platform whose check throws aborts THAT platform and leaves its rows;
 *   - a batch that comes back empty is treated as unknown, not as "all deleted"
 *     (the guard lives in each connector, where the response shape is known);
 *   - a sweep that fails entirely simply happens again later.
 *
 * The cost of being too cautious is that a deleted post lingers until the next
 * sweep. The cost of being too eager is the permanent erasure of an inbox we
 * cannot rebuild. Those are not comparable, and the code should not pretend they
 * are.
 */

export interface PlatformSweep {
  platform: Platform;
  checked: number;
  redacted: number;
  /** Set when nothing was checked, and why. Never silently zero. */
  skipped?: string;
}

export interface SweepReport {
  platforms: PlatformSweep[];
  retentionRedacted: number;
  retentionDays: number | null;
}

/**
 * Ask one platform which of its stored mentions are gone, and strip those.
 *
 * `markChecked` covers everything asked about, not just what came back deleted.
 * Miss that and surviving rows keep their old `last_checked_at`, sort to the
 * front of the next sweep, and the same handful gets re-checked for ever while
 * the rest of the table is never reached — a sweep that looks busy and covers
 * nothing.
 */
export async function sweepPlatform(platform: Platform, limit: number): Promise<PlatformSweep> {
  const store = getStore();
  const connector = connectorFor(platform);

  if (!connector?.findDeleted) {
    return {
      platform,
      checked: 0,
      redacted: 0,
      skipped: "connector has no deletion check",
    };
  }
  if (!connector.isConfigured()) {
    return { platform, checked: 0, redacted: 0, skipped: "not configured" };
  }

  const due = await store.dueForDeletionCheck(platform, limit);
  if (!due.length) return { platform, checked: 0, redacted: 0 };

  const gone = await connector.findDeleted(
    due.map((m) => ({ externalId: m.externalId, raw: m.raw }))
  );

  // findDeleted answers in the platform's ids; the store works in ours.
  const byExternal = new Map(due.map((m) => [m.externalId, m.id]));
  const ids = gone.map((ext) => byExternal.get(ext)).filter((id): id is string => Boolean(id));

  const redacted = ids.length ? await store.redact(ids, "deleted_upstream") : 0;
  await store.markChecked(due.map((m) => m.id));

  return { platform, checked: due.length, redacted };
}

/** Strip anything older than the ceiling, whether or not it still exists. */
export async function sweepRetention(days: number, limit: number): Promise<number> {
  if (!days || days <= 0) return 0;
  const store = getStore();
  const old = await store.olderThan(days, limit);
  if (!old.length) return 0;
  return store.redact(old.map((m) => m.id), "retention");
}

/**
 * One full pass: every enabled platform, then the retention ceiling.
 *
 * A platform that throws is logged and skipped — one broken API must not stop
 * the others, and it must not be recorded as a clean result either.
 */
export async function runRedactionSweep(): Promise<SweepReport> {
  const limit = config.redaction.batchSize;
  const platforms: PlatformSweep[] = [];

  for (const c of enabledConnectors()) {
    try {
      platforms.push(await sweepPlatform(c.platform, limit));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      platforms.push({ platform: c.platform, checked: 0, redacted: 0, skipped: msg });
    }
  }

  let retentionRedacted = 0;
  try {
    retentionRedacted = await sweepRetention(config.redaction.retentionDays, limit);
  } catch (err) {
    console.error("[redact] retention pass failed", err);
  }

  const report: SweepReport = {
    platforms,
    retentionRedacted,
    retentionDays: config.redaction.retentionDays || null,
  };
  logSweep(report);
  return report;
}

function logSweep(r: SweepReport): void {
  for (const p of r.platforms) {
    if (p.skipped) {
      // Loud on purpose. "0 redacted" and "never looked" are the same number and
      // opposite facts, and only one of them is a compliance problem.
      console.warn(`[redact] ${p.platform}: NOT CHECKED — ${p.skipped}`);
    } else {
      console.log(`[redact] ${p.platform}: ${p.checked} checked, ${p.redacted} gone upstream`);
    }
  }
  if (r.retentionDays) {
    console.log(`[redact] retention (${r.retentionDays}d): ${r.retentionRedacted} stripped`);
  } else {
    console.warn("[redact] retention ceiling is OFF (RETENTION_DAYS=0) — content is kept indefinitely");
  }
}
