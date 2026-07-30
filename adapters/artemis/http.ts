export class ArtemisHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly responseBody: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(
      `Artemis ${path} returned HTTP ${status}${
        responseBody ? `: ${responseBody.slice(0, 500)}` : ""
      }`,
    );
    this.name = "ArtemisHttpError";
  }
}

export class ArtemisHttpClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly authorization: string | undefined,
    private readonly requestTimeoutMs: number,
    private readonly maxRetries: number,
    private readonly maxResponseBytes: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async json<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    const mayRetry = options.retry === true || (options.method ?? "GET") === "GET";
    let lastError: unknown;
    for (let attempt = 0; attempt <= (mayRetry ? this.maxRetries : 0); attempt += 1) {
      try {
        return await this.jsonOnce<T>(path, options);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted || attempt >= this.maxRetries || !isRetryable(error)) {
          throw error;
        }
        const retryAfter = error instanceof ArtemisHttpError ? error.retryAfterMs : undefined;
        const delay =
          retryAfter ?? Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 100), 5_000);
        if (options.signal) {
          await sleep(delay, options.signal);
        } else {
          await Bun.sleep(delay);
        }
      }
    }
    throw lastError;
  }

  private async jsonOnce<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const propagateAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", propagateAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(new Error(`Artemis request timed out after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    try {
      const headers = new Headers({
        accept: "application/json",
        ...options.headers,
      });
      if (this.authorization !== undefined) {
        headers.set("authorization", this.authorization);
      }
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          size += result.value.byteLength;
          if (size > this.maxResponseBytes) {
            await reader.cancel();
            throw new Error(`Artemis ${path} response exceeds ${this.maxResponseBytes} bytes`);
          }
          chunks.push(result.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(bytes);
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
        throw new ArtemisHttpError(
          response.status,
          path,
          text,
          Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined,
        );
      }
      if (text.length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Artemis ${path} returned invalid JSON`);
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", propagateAbort);
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof ArtemisHttpError
    ? [408, 425, 429, 502, 503, 504].includes(error.status)
    : error instanceof TypeError ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("timed out")));
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
