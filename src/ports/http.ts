/** One JSON-over-HTTP path for every outbound call, so timeouts, retries and error text behave the same everywhere. */

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  /** From a Retry-After header in seconds, or null when the server gave none. */
  readonly retryAfterMs: number | null;

  constructor(status: number, url: string, body: string, retryAfterMs: number | null = null) {
    super(`${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Waits between retries of a transient failure. Everything this service calls
 * (the model, Papra's API, AirTrail) is async and hidden from a user, so
 * waiting a few seconds is always better than parking a document over a blip
 * like Mistral's "503 upstream connect error ... reset reason: overflow" or a
 * Papra write that lost a lock race.
 */
const RETRY_DELAYS_MS = [2_000, 10_000];

/**
 * A 429 is "slow down", not "broken": Mistral limits requests per minute
 * (mistral-large-latest was 15/min), so a sweep or a burst of uploads hits it
 * by design. Seconds-apart retries would all land in the same window, so wait
 * as long as the server asks, or half a window, and keep at it for a few
 * minutes. Documents are processed one at a time, so this paces the whole run.
 */
const RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 120_000;
const RATE_LIMIT_RETRIES = 6;

/** Worth retrying: server-side failures and connection drops — not 4xx contract errors or our own timeout. */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  // fetch wraps network failures (reset, refused, DNS) in TypeError. An
  // AbortError from our own timeout is deliberately not retried: the timeouts
  // are generous, so repeating one only multiplies the wait.
  return error instanceof TypeError;
}

function parseRetryAfter(header: string | null): number | null {
  const seconds = Number(header ?? "");
  return header && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestJson(
  url: string,
  options: {
    payload?: unknown;
    token?: string;
    method?: string;
    timeoutMs?: number;
    /** Test seams; production callers keep the defaults. */
    retryDelaysMs?: number[];
    rateLimitWaitMs?: number;
  } = {},
): Promise<any> {
  const {
    payload,
    token,
    method,
    timeoutMs = 180_000,
    retryDelaysMs = RETRY_DELAYS_MS,
    rateLimitWaitMs = RATE_LIMIT_WAIT_MS,
  } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let failures = 0;
  let rateLimited = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: method ?? (payload !== undefined ? "POST" : "GET"),
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        throw new HttpError(response.status, url, text, retryAfter);
      }
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) {
        if (rateLimited++ >= RATE_LIMIT_RETRIES) throw error;
        await sleep(Math.min(error.retryAfterMs ?? rateLimitWaitMs, RATE_LIMIT_MAX_WAIT_MS));
        continue;
      }
      if (failures >= retryDelaysMs.length || !isTransient(error)) throw error;
      await sleep(retryDelaysMs[failures++]);
    }
  }
}
