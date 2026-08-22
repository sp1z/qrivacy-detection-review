import { getStore } from "../store/index.js";
import type { MentionRecord } from "../store/types.js";
import type { NormalizedMention } from "../connectors/types.js";
import { enrich } from "./classify.js";
import { maybeAutoRespond } from "./respond.js";
import { maybeAutoResolve } from "./autoresolve.js";
import { noteOptOutRequest } from "./optout.js";

/**
 * The single funnel every mention passes through, whether it arrived by poll
 * or webhook. Stores idempotently and returns the records that were genuinely
 * new so callers act on each mention exactly once.
 */
export async function ingest(
  mentions: NormalizedMention[]
): Promise<MentionRecord[]> {
  const store = getStore();
  const fresh: MentionRecord[] = [];
  for (const m of mentions) {
    try {
      // Classify + decode QR from any images before storing, so a code that
      // appears without an @mention still becomes a first-class detection.
      const enriched = await enrich(m);
      const { inserted, record } = await store.insert(enriched);
      if (inserted) {
        fresh.push(record);
        await onNewMention(record);
      }
    } catch (err) {
      console.error(
        `[ingest] failed to store ${m.platform}:${m.externalId}`,
        err
      );
    }
  }
  return fresh;
}

async function onNewMention(m: MentionRecord): Promise<void> {
  const codes = m.extractedCodes.length ? ` codes=[${m.extractedCodes.join(",")}]` : "";
  console.log(
    `[detect:${m.matchType}] ${m.platform} ${m.authorHandle ?? "?"}${codes} — ${m.permalink ?? m.externalId}`
  );
  // Link it to a wearer's code when exactly one code is on offer (opt-in), so
  // an unambiguous detection reaches the owner without waiting on a human.
  // Anything needing a judgement call stays in the inbox.
  await maybeAutoResolve(m);

  // "Stop talking to me" is recorded BEFORE the reply decision, so the reply it
  // suppresses is this one rather than the next. Someone answering our comment
  // with "bad bot" would otherwise get one more comment out of us, which is the
  // opposite of what they asked for.
  await noteOptOutRequest(m);

  // "Respond accordingly": auto-acknowledge if enabled; otherwise it waits in
  // the triage inbox for a human to link it to a wearer's code.
  await maybeAutoRespond(m);
}
