/**
 * Shared HTTP plumbing for connectors. Every platform hits a JSON API over
 * HTTPS and every one of them has to handle the same four things: a timeout, a
 * 429, a non-2xx body worth putting in the log, and a response that isn't
 * actually JSON. Doing that once here keeps each connector down to the part
 * that's genuinely platform-specific — the query and the normalisation.
 */

/** Thrown on 429 so the scheduler can tell "back off" from "broken". */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | null;
  constructor(platform: string, retryAfterMs: number | null) {
    super(`${platform}: rate limited (429)`);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other non-2xx. Carries the status so callers can special-case auth. */
export class ConnectorHttpError extends Error {
  readonly status: number;
  constructor(platform: string, status: number, body: string) {
    super(`${platform}: request failed ${status} ${body.slice(0, 300)}`);
    this.name = "ConnectorHttpError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchJsonOptions {
  /** Platform name — only used to prefix error messages. */
  platform: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Serialised as JSON and sent with a JSON content-type. */
  body?: unknown;
  /**
   * Sent as `application/x-www-form-urlencoded` instead of JSON. Reddit's OAuth
   * token endpoint and its whole write API accept ONLY form encoding — posting
   * JSON to them returns a 200 with an empty result, which reads as a silent
   * no-op rather than an error. Mutually exclusive with `body`.
   */
  form?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * GET/POST a JSON endpoint with a timeout, throwing typed errors. Returns the
 * parsed body — callers supply the shape, which is checked nowhere at runtime,
 * so treat it as untrusted and normalise defensively.
 */
export async function fetchJson<T>(
  url: string,
  opts: FetchJsonOptions
): Promise<T> {
  const { platform, method = "GET", headers = {}, body, form, timeoutMs } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: form
        ? { "content-type": "application/x-www-form-urlencoded", ...headers }
        : body
          ? { "content-type": "application/json", ...headers }
          : headers,
      body: form
        ? new URLSearchParams(form).toString()
        : body === undefined
          ? undefined
          : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    // An aborted fetch surfaces as a DOMException; make it legible in the log.
    const msg = ac.signal.aborted ? `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : String(err);
    throw new Error(`${platform}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new RateLimitError(platform, retryAfterMs(res.headers.get("retry-after")));
  }
  if (!res.ok) {
    throw new ConnectorHttpError(platform, res.status, await res.text().catch(() => ""));
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${platform}: response was not JSON (${text.slice(0, 200)})`);
  }
}

/** Retry-After is either delta-seconds or an HTTP date. Null if neither. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
