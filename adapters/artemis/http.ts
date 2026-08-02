import { setTimeout as delay } from "node:timers/promises";

export class ArtemisHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly responseBody: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(
      `Artemis ${path} returned HTTP ${status}${responseBody ? `: ${responseBody.slice(0, 500)}` : ""}`,
    );
    this.name = "ArtemisHttpError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  retry?: boolean;
}

export function jwtCookie(headers: Headers): string | undefined {
  for (const value of headers.getSetCookie()) {
    const match = value.match(/^\s*jwt=([^;]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export class ArtemisHttpClient {
  private readonly baseUrl: string;
  private responseBytes = 0;
  private authorization: string | undefined;
  private cookie: string | undefined;
  private deadlineAt: number | undefined;

  constructor(
    baseUrl: string,
    authorization: string | undefined,
    private readonly requestTimeoutMs: number,
    private readonly maxRetries: number,
    private readonly maxResponseBytes: number,
    private readonly maxTotalResponseBytes: number,
    private readonly maxRetryDelayMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authorization = authorization;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
    this.authorization = undefined;
  }

  setDeadline(deadlineAt: number): void {
    this.deadlineAt = deadlineAt;
  }

  async jsonResponse<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ value: T; headers: Headers }> {
    const response = await this.request(path, options);
    if (response.bytes.byteLength === 0)
      return { value: undefined as T, headers: response.headers };
    try {
      return {
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)) as T,
        headers: response.headers,
      };
    } catch {
      throw new Error(`Artemis ${path} returned invalid JSON`);
    }
  }

  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.jsonResponse<T>(path, options)).value;
  }

  async bytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return (await this.request(path, options)).bytes;
  }

  private retryDelayMs(attempt: number, error: unknown): number | undefined {
    const suggested = error instanceof ArtemisHttpError ? error.retryAfterMs : undefined;
    const delay = Math.min(suggested ?? Math.min(250 * 2 ** attempt, 5_000), this.maxRetryDelayMs);
    const remaining =
      this.deadlineAt === undefined ? Number.POSITIVE_INFINITY : this.deadlineAt - Date.now();
    return delay >= remaining ? undefined : delay;
  }

  private async request(
    path: string,
    options: RequestOptions,
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    if (!path.startsWith("/")) throw new Error("Artemis request paths must be absolute");
    const mayRetry = options.retry === true || (options.method ?? "GET") === "GET";
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(path, options);
      } catch (error) {
        if (
          !mayRetry ||
          options.signal?.aborted ||
          attempt >= this.maxRetries ||
          !isRetryable(error)
        ) {
          throw error;
        }
        const delay = this.retryDelayMs(attempt, error);
        if (delay === undefined) throw error;
        await sleep(delay, options.signal);
      }
    }
  }

  private async requestOnce(
    path: string,
    options: RequestOptions,
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const budget = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
    try {
      const headers = new Headers({
        accept: "application/json",
        // Artemis rejects an authentication request without User-Agent with HTTP 400.
        "user-agent": "exgen-bench-artemis-adapter",
        ...options.headers,
      });
      if (this.authorization) headers.set("authorization", this.authorization);
      if (this.cookie) headers.set("cookie", this.cookie);
      if (options.body !== undefined) headers.set("content-type", "application/json");
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal,
      });
      const bytes = await readBounded(response, path, this.maxResponseBytes);
      this.responseBytes += bytes.byteLength;
      if (this.responseBytes > this.maxTotalResponseBytes) {
        throw new Error(
          `Artemis responses exceed the cumulative limit max_http_total_bytes (${this.maxTotalResponseBytes} bytes) at ${path}`,
        );
      }
      if (!response.ok) {
        const text = new TextDecoder().decode(bytes);
        throw new ArtemisHttpError(
          response.status,
          path,
          text,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      return { bytes, headers: response.headers };
    } catch (error) {
      if (budget.aborted && !options.signal?.aborted) {
        throw new Error(`Artemis ${path} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }
}

async function readBounded(response: Response, path: string, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error(`Artemis ${path} response exceeds max_http_response_bytes (${limit} bytes)`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Artemis ${path} response exceeds max_http_response_bytes (${limit} bytes)`);
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ArtemisHttpError
    ? [408, 425, 429, 502, 503, 504].includes(error.status)
    : error instanceof TypeError ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("timed out")));
}

export async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await delay(milliseconds);
    return;
  }
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}
