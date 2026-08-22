import type { MentionRecord } from "../store/types.js";

/**
 * What the bot actually says.
 *
 * The brief for this service is "be a helpful social force", and the test of
 * that is simple: would this reply be worth reading by someone who has never
 * heard of QRivacy and never will? So the useful part — what actually works
 * when you are in a video you did not agree to — comes first and stands alone,
 * and the product is mentioned once, at the point where it is relevant.
 *
 * The substance is qrivacy.me/guidance condensed: save the evidence, report
 * under PRIVACY rather than as a general complaint, ask for something specific,
 * escalate to a regulator. Plus the carve-out that matters more than any of it
 * — intimate images and anything involving a child do not belong in a takedown
 * workflow, they belong with the police.
 *
 * Two lengths, because the platforms are not alike: Bluesky caps a post at 300
 * graphemes, so it gets one sentence and a link. Reddit is a long-form comment
 * surface where a one-liner with a URL reads as an advert and gets removed as
 * one, so it gets the steps in full.
 */

const SITE = "https://qrivacy.me";
const GUIDANCE = `${SITE}/guidance`;

/** Short-form acknowledgement — the 300-character platforms. */
export function acknowledgementText(m: MentionRecord): string {
  const who = m.authorHandle ? `${m.authorHandle} ` : "";
  return (
    `${who}thanks for flagging this 🙏 If someone's QR privacy code is in your ` +
    `post, they can see it and request a takedown at qrivacy.me. Not everyone ` +
    `wants to be content.`
  );
}

/**
 * A bot that does not say it is a bot is the thing subreddits ban. The claim
 * here about when we speak is not marketing — it is the literal behaviour, and
 * it is what makes the opt-out credible.
 */
const FOOTER =
  `\n\n---\n\n^(I'm a bot run by QRivacy — wearable QR codes that let a stranger tell you, ) ` +
  `^(anonymously, that you turned up in their footage. I only reply when someone tags me or posts ) ` +
  `^(a QRivacy link — I don't scan for keywords. Reply **bad bot** and I won't reply to you again. ) ` +
  `^([More](${SITE}/about))`;

/** Someone posted or spotted a wearer's code. Explain what they've found. */
function codeLinkReply(m: MentionRecord): string {
  const who = m.authorHandle ? `Hi ${m.authorHandle} — ` : "";
  return (
    `${who}that link is a **QRivacy code**. Somebody wears it — on a pin, a patch, a sticker — ` +
    `precisely because they'd rather not end up in other people's photos and videos.\n\n` +
    `Opening it lets you tell them, **anonymously**, where you saw them. You never find out who ` +
    `they are, they never find out who you are; they just learn that their face turned up ` +
    `somewhere, and get help asking for it to be taken down. That's the whole mechanism.\n\n` +
    `And if **you're** the one in something you didn't agree to, you don't need a code to get ` +
    `help — the steps are at ${GUIDANCE}.` +
    FOOTER
  );
}

/** Someone summoned us. Give them the actual answer, not a brochure. */
function summonedReply(m: MentionRecord): string {
  const who = m.authorHandle ? `Hi ${m.authorHandle} — ` : "";
  return (
    `${who}if you're in a photo or video you didn't agree to, here's what actually tends to work:\n\n` +
    `1. **Save the evidence first.** Screenshot or screen-record it, copy the exact link, note the ` +
    `date. It has a habit of vanishing the moment you complain — and then you can't prove it ` +
    `existed.\n` +
    `2. **Report it under _privacy_, not "I don't like this".** Every big platform has a separate ` +
    `privacy / image-removal form, and it's a different and much faster queue than the general ` +
    `report button.\n` +
    `3. **Ask for something specific** — the part featuring you removed, or your face blurred. ` +
    `Vague requests get closed.\n` +
    `4. **Escalate if they ignore you** — your country's data-protection or online-safety ` +
    `regulator, which platforms answer to in a way they don't answer to you.\n\n` +
    `Per-platform forms and the legal position where you live: ${GUIDANCE}\n\n` +
    `Worth knowing before you spend money: in most places filming in public isn't itself illegal, ` +
    `and the copyright belongs to whoever pointed the camera — not to you. That's why a platform ` +
    `takedown is usually the realistic route and a lawsuit usually isn't.\n\n` +
    `**One exception:** if this is an intimate image shared without consent, or anything sexual ` +
    `involving a child, don't use any of the above — go to the police. That is not a takedown-form ` +
    `problem.` +
    FOOTER
  );
}

/** Long-form reply for comment platforms (currently Reddit). */
export function longFormReply(m: MentionRecord): string {
  return m.matchType === "code_link" || m.matchType === "qr_image"
    ? codeLinkReply(m)
    : summonedReply(m);
}

/** The reply this mention should get, in the register its platform expects. */
export function replyTextFor(m: MentionRecord): string {
  return m.platform === "reddit" ? longFormReply(m) : acknowledgementText(m);
}
