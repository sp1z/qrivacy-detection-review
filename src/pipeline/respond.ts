import { config } from "../config.js";
import { connectorFor } from "../connectors/index.js";
import type { MatchType } from "../connectors/types.js";
import { getStore } from "../store/index.js";
import type { MentionRecord } from "../store/types.js";
import { replyTextFor } from "./reply-text.js";

/**
 * "Respond accordingly." Default posture: do nothing automatic and let a human
 * triage each mention in the inbox — safest while we tune tone and avoid
 * replying to spam. Auto-acknowledge is opt-in (AUTO_ACKNOWLEDGE=1) and only
 * fires on platforms whose connector has WRITE credentials.
 *
 * Three gates stand between a new mention and an automatic public reply, checked
 * in this order because each is cheaper than the last:
 *
 *   1. **the trigger** — did this person actually address us? (below)
 *   2. **the opt-out** — have they told us to stop? (`pipeline/optout.ts`)
 *   3. **platform etiquette** — is this a place we should speak at all?
 *      (`Connector.mayReplyTo`: subreddit rules, thread dedupe, NSFW)
 *
 * A human pressing "Acknowledge" in the triage UI passes `manual` and skips
 * only gate 1 — the queue exists precisely so a person can answer something the
 * bot wouldn't have. Gates 2 and 3 bind either way: an opt-out is a promise, and
 * a subreddit that bans bots bans them whoever pressed the key.
 */

/**
 * Why a mention must have fired for the bot to speak on its own. All three mean
 * the person put us, or a wearer's code, in front of us. There is no keyword
 * trigger and there must never be one: replying to strangers because they used
 * the word "filmed" is precisely the behaviour that gets a bot banned and the
 * brand resented.
 *
 * Today this is belt and braces — the footprint search only ever surfaces these
 * three. It is written down so that adding a keyword source later cannot
 * quietly turn the bot into an unsolicited one.
 */
const AUTO_REPLY_TRIGGERS: MatchType[] = ["handle_mention", "code_link", "qr_image"];

export function isAutoReplyTrigger(m: MentionRecord): boolean {
  return AUTO_REPLY_TRIGGERS.includes(m.matchType);
}

// Re-exported for the triage UI and existing callers/tests.
export { replyTextFor as acknowledgementText };

export async function maybeAutoRespond(m: MentionRecord): Promise<void> {
  if (!config.autoAcknowledge) return;
  await acknowledge(m);
}

export interface AcknowledgeOptions {
  /** A human pressed the button, rather than the poller deciding. */
  manual?: boolean;
}

export interface AcknowledgeResult {
  ok: boolean;
  error?: string;
  /** Set when we deliberately said nothing. A refusal, not a fault. */
  skipped?: string;
}

/**
 * Post the reply for a mention and record it. Idempotent-ish via status (won't
 * re-reply to an already-responded mention).
 */
export async function acknowledge(
  m: MentionRecord,
  opts: AcknowledgeOptions = {}
): Promise<AcknowledgeResult> {
  if (m.status === "responded") return { ok: true };

  const connector = connectorFor(m.platform);
  if (!connector?.canReply() || !connector.reply) {
    return { ok: false, error: `${m.platform}: replies not available` };
  }

  if (!opts.manual && !isAutoReplyTrigger(m)) {
    return skip(m, `matchType=${m.matchType} is not an auto-reply trigger`);
  }

  if (m.authorHandle && (await getStore().isOptedOut(m.platform, m.authorHandle))) {
    return skip(m, `${m.authorHandle} has opted out`);
  }

  if (connector.mayReplyTo) {
    const gate = await connector.mayReplyTo(m);
    if (!gate.ok) return skip(m, gate.reason);
  }

  const res = await connector.reply(m, replyTextFor(m));
  if (!res.ok) {
    console.error(`[respond] ${m.platform} ${m.externalId}: ${res.error}`);
    return { ok: false, error: res.error };
  }
  await getStore().update(m.id, { status: "responded" });
  console.log(`[respond] replied to ${m.platform} ${m.externalId} -> ${res.externalId}`);
  return { ok: true };
}

/**
 * Declining to speak is logged but never marks the mention as handled — it
 * stays in the inbox, because "the bot shouldn't say this" is often exactly the
 * case where a person should.
 */
function skip(m: MentionRecord, reason: string): AcknowledgeResult {
  console.log(`[respond] skipped ${m.platform} ${m.externalId}: ${reason}`);
  return { ok: false, skipped: reason, error: `not replied: ${reason}` };
}
