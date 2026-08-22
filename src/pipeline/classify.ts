import { config } from "../config.js";
import type { NormalizedMention } from "../connectors/types.js";
import { classifyMatch, resolveCandidates } from "./resolve.js";
import { scanImageUrlForCodes } from "./qr.js";

/**
 * Enrich a raw detection before it's stored: decode QR codes from any attached
 * images, gather codes from the text, and decide the matchType. This is where a
 * post that shows a code but never tags us becomes a first-class detection.
 */
export async function enrich(m: NormalizedMention): Promise<NormalizedMention> {
  const textCodes = resolveCandidates(m.text).codes;

  let qrCodes: string[] = [];
  if (config.qrDecode && m.mediaUrls?.length) {
    for (const url of m.mediaUrls) {
      try {
        qrCodes.push(...(await scanImageUrlForCodes(url)));
      } catch {
        // decoding is best-effort; never fail ingestion over an image
      }
    }
  }

  const extractedCodes = [...new Set([...textCodes, ...qrCodes])];
  const matchType = classifyMatch(m.text, qrCodes);

  return { ...m, matchType, extractedCodes };
}
