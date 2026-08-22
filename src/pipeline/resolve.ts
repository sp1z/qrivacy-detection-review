/**
 * Code resolution — pull the signals out of a detection that help triage link
 * it to a QRivacy wearer. Two things can carry a code: a report URL in the text
 * (qrivacy.me/r/<code>, or the newer/shorter domain + path) or a QR in an image.
 * A mention of the handle alone carries no code, so we surface every candidate
 * we can find:
 *
 *   - a qrivacy code from a report link on ANY configured host/path → strongest;
 *   - any other URL → a candidate "source" (where the wearer appeared);
 *   - @handles → who else was tagged.
 *
 * Hosts and paths are configuration, never hardcoded — the domain has forked
 * and more paths are coming. Pure and side-effect free so it's easily testable.
 */
import { config } from "../config.js";

/** A qrivacy code is a short token: letters/digits, up to 32 chars (schema). */
const CODE_CHARS = "[A-Za-z0-9]{3,32}";

const urlRe = /https?:\/\/[^\s"'<>)]+/gi;
const handleRe = /@([A-Za-z0-9_.]{2,30})/g;

// Explicit "code: 7k2m9" callouts (host-independent). Colon required — matching
// a bare "code X" on whitespace captures the next English word.
const explicitCodeRe = new RegExp(`\\bcode:\\s*(${CODE_CHARS})\\b`, "gi");

export type MatchType = "handle_mention" | "code_link" | "qr_image" | "unknown";

export interface ResolveOptions {
  watchHandle?: string;
  /** Full "host/path/" prefixes a code follows, e.g. ["qxa.me/","qrivacy.me/r/"]. */
  prefixes?: string[];
}

export interface ResolvedCandidates {
  /** qrivacy codes found in the text (from report links), deduped. */
  codes: string[];
  /** Non-qrivacy URLs — candidate sources of the sighting. */
  urls: string[];
  /** @handles mentioned, excluding our own watch handle. */
  handles: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build the report-link regex from full "host/path/" prefixes. Longer prefixes
 *  first so "qrivacy.me/r/" wins over a hypothetical bare "qrivacy.me/". */
function reportLinkRe(prefixes: string[]): RegExp {
  const alt = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join("|");
  return new RegExp(
    `(?:https?://)?(?:www\\.)?(?:${alt})(${CODE_CHARS})`,
    "gi"
  );
}

function hostsOf(prefixes: string[]): string[] {
  return prefixes.map((p) => p.split("/")[0].toLowerCase());
}

function isCodeHost(url: string, hosts: string[]): boolean {
  const u = url.toLowerCase();
  return hosts.some((h) => u.includes(h));
}

export function resolveCandidates(
  text: string,
  opts: ResolveOptions = {}
): ResolvedCandidates {
  const input = text ?? "";
  const prefixes = opts.prefixes ?? config.codeLinkPrefixes;
  const hosts = hostsOf(prefixes);
  const watch = (opts.watchHandle ?? config.watchHandle ?? "")
    .replace(/^@/, "")
    .toLowerCase();

  const codes = new Set<string>();
  const urls = new Set<string>();
  const handles = new Set<string>();

  // Codes are canonically UPPERCASE in the qrivacy DB (all 513 of them), but a
  // link is typed by a human — "qxa.me/7k2m9" is the same code as "qxa.me/7K2M9".
  // Normalising here means one canonical form is stored, the two spellings dedupe
  // to a single candidate, and nothing downstream depends on the case that
  // happened to be typed. Codes are [A-Za-z0-9] only, so this is lossless.
  for (const m of input.matchAll(reportLinkRe(prefixes)))
    codes.add(m[1].toUpperCase());
  for (const m of input.matchAll(explicitCodeRe)) codes.add(m[1].toUpperCase());

  for (const m of input.matchAll(urlRe)) {
    const url = m[0].replace(/[.,)]+$/, ""); // trim trailing punctuation
    if (!isCodeHost(url, hosts)) urls.add(url);
  }

  for (const m of input.matchAll(handleRe)) {
    if (m[1].toLowerCase() !== watch) handles.add(`@${m[1]}`);
  }

  return { codes: [...codes], urls: [...urls], handles: [...handles] };
}

/** Extract just the codes from an arbitrary decoded string (e.g. a QR payload). */
export function codesFrom(text: string, opts: ResolveOptions = {}): string[] {
  return resolveCandidates(text, opts).codes;
}

/** The single best code candidate, if the text points to exactly one. */
export function primaryCode(text: string, opts: ResolveOptions = {}): string | null {
  const { codes } = resolveCandidates(text, opts);
  return codes.length === 1 ? codes[0] : null;
}

/**
 * Does this text summon us? Platforms spell a mention differently and the
 * spelling is not cosmetic — it decides `matchType`, which is what gates every
 * automatic reply. Reddit writes `u/qrivacyme` or `/u/qrivacyme` and nobody
 * there types an `@`, so an @-only test classifies every Reddit summon as
 * "unknown" and the bot silently never answers the people who asked it to.
 */
function mentionsHandle(text: string, watchHandle: string): boolean {
  const h = watchHandle.replace(/^@/, "").toLowerCase();
  if (!h) return false;
  return new RegExp(`(?:@|\\bu/|/u/)${esc(h)}\\b`, "i").test(text ?? "");
}

/**
 * Decide WHY a detection fired, given its text and any codes recovered from
 * images. QR wins (strongest proof the code was physically present), then a
 * code link in text, then a bare handle mention.
 */
export function classifyMatch(
  text: string,
  qrCodes: string[],
  opts: ResolveOptions = {}
): MatchType {
  if (qrCodes.length) return "qr_image";
  if (resolveCandidates(text, opts).codes.length) return "code_link";
  if (mentionsHandle(text, opts.watchHandle ?? config.watchHandle))
    return "handle_mention";
  return "unknown";
}
