/** One JSON-over-HTTP path for every outbound call, so timeouts and error text behave the same everywhere. */

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

export async function requestJson(
  url: string,
  options: {
    payload?: unknown;
    token?: string;
    method?: string;
    timeoutMs?: number;
  } = {},
): Promise<any> {
  const { payload, token, method, timeoutMs = 180_000 } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(url, {
    method: method ?? (payload !== undefined ? "POST" : "GET"),
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, text);
  return text.trim() ? JSON.parse(text) : {};
}
