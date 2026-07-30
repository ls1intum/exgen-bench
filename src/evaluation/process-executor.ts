import type { EvaluationRequest, EvaluationResponse } from "./contracts.ts";
import {
  EvaluationTimeoutError,
  type EvaluationExecutionContext,
  type EvaluationExecutor,
} from "./runner.ts";

interface Schema<T> {
  parse(value: unknown): T;
}

export interface EvaluationProcessExecutorOptions {
  argv: readonly [string, ...string[]];
  input: (request: EvaluationRequest) => unknown;
  responseSchema: Schema<EvaluationResponse>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  maximumInputBytes?: number;
  maximumResponseBytes?: number;
  maximumLogBytes?: number;
  terminationGraceMs?: number;
}

interface CapturedBytes {
  bytes: Uint8Array;
  exceeded: boolean;
}

const DEFAULT_INPUT_MAXIMUM_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_MAXIMUM_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOG_MAXIMUM_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

async function captureBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimit: () => void,
): Promise<CapturedBytes> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    const remaining = maximumBytes - length;
    if (remaining > 0) {
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(accepted);
      length += accepted.byteLength;
    }
    if (chunk.byteLength > remaining) {
      exceeded = true;
      onLimit();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("evaluation aborted");
}

export function createEvaluationProcessExecutor(
  options: EvaluationProcessExecutorOptions,
): EvaluationExecutor {
  if (options.argv.length === 0 || options.argv.some((argument) => argument.length === 0)) {
    throw new Error("evaluation process argv must contain non-empty arguments");
  }
  const maximumInputBytes = positiveLimit(
    options.maximumInputBytes,
    DEFAULT_INPUT_MAXIMUM_BYTES,
    "maximumInputBytes",
  );
  const maximumResponseBytes = positiveLimit(
    options.maximumResponseBytes,
    DEFAULT_RESPONSE_MAXIMUM_BYTES,
    "maximumResponseBytes",
  );
  const maximumLogBytes = positiveLimit(
    options.maximumLogBytes,
    DEFAULT_LOG_MAXIMUM_BYTES,
    "maximumLogBytes",
  );
  const terminationGraceMs = positiveLimit(
    options.terminationGraceMs,
    DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );

  const execute = async (
    request: EvaluationRequest,
    context: EvaluationExecutionContext,
  ): Promise<EvaluationResponse> => {
    if (context.signal.aborted) {
      throw abortError(context.signal);
    }
    const input = `${JSON.stringify(options.input(request))}\n`;
    if (Buffer.byteLength(input) > maximumInputBytes) {
      throw new Error(`evaluation process input exceeds ${maximumInputBytes} bytes`);
    }

    const subprocess = Bun.spawn([...options.argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let terminationReason: Error | undefined;
    let termination: Promise<void> | undefined;
    const terminate = (reason: Error): void => {
      if (termination !== undefined) {
        return;
      }
      terminationReason = reason;
      try {
        subprocess.kill("SIGTERM");
      } catch {
        // The exit promise below remains the source of truth.
      }
      termination = (async () => {
        const exitedDuringGrace = await Promise.race([
          subprocess.exited.then(() => true),
          Bun.sleep(terminationGraceMs).then(() => false),
        ]);
        if (!exitedDuringGrace) {
          try {
            subprocess.kill("SIGKILL");
          } catch {
            // The process exited after the grace-period race resolved.
          }
        }
        await subprocess.exited;
      })();
    };
    const abort = (): void => terminate(abortError(context.signal));
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      abort();
    }
    const timeout =
      request.timeout_ms === undefined
        ? undefined
        : setTimeout(
            () => terminate(new EvaluationTimeoutError("evaluation exceeded its wall-time limit")),
            request.timeout_ms,
          );

    try {
      const responseOutput = captureBytes(subprocess.stdout, maximumResponseBytes, () =>
        terminate(new Error(`evaluation response exceeds ${maximumResponseBytes} bytes`)),
      );
      const logOutput = captureBytes(subprocess.stderr, maximumLogBytes, () =>
        terminate(new Error(`evaluation logs exceed ${maximumLogBytes} bytes`)),
      );
      subprocess.stdin.write(input);
      subprocess.stdin.end();
      let result: [number, CapturedBytes, CapturedBytes];
      try {
        result = await Promise.all([subprocess.exited, responseOutput, logOutput]);
      } catch (error) {
        terminate(error instanceof Error ? error : new Error("evaluation process failed"));
        await termination;
        await Promise.allSettled([responseOutput, logOutput]);
        throw error;
      }
      const [exitCode, response, logs] = result;
      if (termination !== undefined) {
        await termination;
      }
      if (terminationReason !== undefined) {
        throw terminationReason;
      }
      if (response.exceeded || logs.exceeded) {
        throw new Error("evaluation process exceeded its output limits");
      }
      if (exitCode !== 0) {
        throw new Error(`evaluation process exited with status ${exitCode}`);
      }
      const responseText = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
      return options.responseSchema.parse(JSON.parse(responseText));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      context.signal.removeEventListener("abort", abort);
      if (termination !== undefined) {
        await termination;
      }
    }
  };
  execute.managesTimeout = true;
  return execute;
}
