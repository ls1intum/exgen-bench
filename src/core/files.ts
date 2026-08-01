import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BoundedReadOptions {
  rejectHardLinks?: boolean;
}

export async function readBytesBounded(
  path: string,
  maximumBytes: number,
  options: BoundedReadOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("maximumBytes must be a non-negative safe integer");
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`expected a regular file: ${path}`);
  }
  if (options.rejectHardLinks === true && metadata.nlink > 1) {
    throw new Error(`expected an independent regular file with one link: ${path}`);
  }
  if (metadata.size > maximumBytes) {
    throw new Error(`file exceeds ${maximumBytes} bytes: ${path}`);
  }
  const bytes = new Uint8Array(
    await Bun.file(path)
      .slice(0, maximumBytes + 1)
      .arrayBuffer(),
  );
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`file exceeds ${maximumBytes} bytes: ${path}`);
  }
  return bytes;
}

export async function readTextBounded(
  path: string,
  maximumBytes: number,
  options: BoundedReadOptions = {},
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBytesBounded(path, maximumBytes, options),
  );
}

export async function readResponseTextBounded(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("maximumBytes must be a non-negative safe integer");
  }
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? undefined : Number(contentLength);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await response.body?.cancel();
    throw new Error(`response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) {
    throw new Error("response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
