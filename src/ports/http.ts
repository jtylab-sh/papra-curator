/** One JSON-over-HTTP path for every outbound call, so timeouts, retries and error text behave the same everywhere. */

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
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

/** Worth retrying: rate limits, server-side failures, and connection drops — not 4xx contract errors or our own timeout. */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  // fetch wraps network failures (reset, refused, DNS) in TypeError. An
  // AbortError from our own timeout is deliberately not retried: the timeouts
  // are generous, so repeating one only multiplies the wait.
  return error instanceof TypeError;
}

export async function requestJson(
  url: string,
  options: {
    payload?: unknown;
    token?: string;
    method?: string;
    timeoutMs?: number;
    /** Test seam; production callers keep the default. */
    retryDelaysMs?: number[];
  } = {},
): Promise<any> {
  const { payload, token, method, timeoutMs = 180_000, retryDelaysMs = RETRY_DELAYS_MS } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: method ?? (payload !== undefined ? "POST" : "GET"),
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new HttpError(response.status, url, text);
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      if (attempt >= retryDelaysMs.length || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
}
