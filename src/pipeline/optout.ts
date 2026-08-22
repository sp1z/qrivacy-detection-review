import { getStore } from "../store/index.js";
import type { MentionRecord } from "../store/types.js";

/**
 * "Leave me alone", honoured permanently.
 *
 * Reddit's bottiquette expects every bot to offer an opt-out and to actually
 * keep it, and the cost of ignoring one is not a telling-off — it is a site-wide
 * ban for the account, which takes the detection channel with it. This is the
 * cheapest possible implementation of that promise: if someone says it to us,
 * we write it down, and we never reply to them again on that platform.
 *
 * It is deliberately platform-agnostic. The trigger phrases are Reddit's idiom,
 * but the guarantee is one we should keep everywhere.
 */

/**
 * Phrases that mean "stop". Anchored to whole words, so "the bad bottleneck" is
 * not an opt-out, and matched case-insensitively.
 *
 * Note what is NOT here: "no", "wrong", "this is spam". Those are complaints
 * about the reply, and a human should read them — silently muting the author is
 * the wrong response to feedback we could learn from.
 */
export const OPT_OUT_RE =
  /\b(bad bot|opt[\s-]?out|stop replying|don'?t reply|do not reply|leave me alone|unsubscribe)\b/i;

export function isOptOutRequest(text: string): boolean {
  return OPT_OUT_RE.test(text ?? "");
}

/**
 * If this mention is someone telling us to stop, record it and say so. Called
 * on every new mention BEFORE any reply decision, so the reply that would have
 * gone out is the one it suppresses — not the one after.
 */
export async function noteOptOutRequest(m: MentionRecord): Promise<boolean> {
  if (!m.authorHandle || !isOptOutRequest(m.text)) return false;
  await getStore().optOut(m.platform, m.authorHandle, m.permalink ?? m.externalId);
  console.log(`[optout] ${m.platform} ${m.authorHandle} asked us to stop — recorded`);
  return true;
}
