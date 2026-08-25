import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveContained } from "../../src/adapters/paths.ts";
import type { BundleFile } from "../shared/bundle.ts";
import { InfrastructureError } from "../shared/protocol.ts";

export interface HostBuildRun {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

const TOOLCHAIN_TIMEOUT_MS = 10_000;
const TOOLCHAIN_OUTPUT_BYTES = 16 * 1024;

export async function writeBuildFiles(root: string, files: BundleFile[]): Promise<void> {
  for (const file of files) {
    const destination = resolveContained(root, file.path, "candidate file");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.rawContent ?? file.content);
  }
}

async function readTail(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  let tail = new Uint8Array();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength >= maximumBytes) {
        tail = value.slice(value.byteLength - maximumBytes);
        continue;
      }
      const keep = Math.min(tail.byteLength, maximumBytes - value.byteLength);
      const next = new Uint8Array(keep + value.byteLength);
      next.set(tail.slice(tail.byteLength - keep));
      next.set(value, keep);
      tail = next;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(tail);
}

export async function inspectHostTool(
  argv: string[],
  environment?: Record<string, string | undefined>,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOLCHAIN_TIMEOUT_MS);
  try {
    const child = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      ...(environment === undefined ? {} : { env: environment }),
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      readTail(child.stdout, TOOLCHAIN_OUTPUT_BYTES),
      readTail(child.stderr, TOOLCHAIN_OUTPUT_BYTES),
    ]);
    return exitCode === 0 ? stdout : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runHostBuild(options: {
  argv: string[];
  directory: string;
  environment?: Record<string, string | undefined>;
  signal: AbortSignal;
  timeoutMs: number;
  maximumOutputBytes: number;
}): Promise<HostBuildRun> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const child = Bun.spawn(options.argv, {
      cwd: options.directory,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      ...(options.environment === undefined ? {} : { env: options.environment }),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readTail(child.stdout, options.maximumOutputBytes),
      readTail(child.stderr, options.maximumOutputBytes),
    ]);
    options.signal.throwIfAborted();
    return {
      exitCode,
      timedOut: controller.signal.aborted,
      output: `${stdout}${stderr}`.slice(-options.maximumOutputBytes),
    };
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new InfrastructureError(
      `could not run ${options.argv[0] ?? "build command"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
