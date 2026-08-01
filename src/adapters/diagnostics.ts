import { lstat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { GenerationResponse } from "../contracts.ts";
import { sha256 } from "../core/canonical.ts";
import { sha256File } from "../core/evidence.ts";
import { readBytesBounded } from "../core/files.ts";
import { rejectSymlinkComponents, resolveContained } from "./paths.ts";

const MAXIMUM_AGGREGATE_DIAGNOSTIC_BYTES = 128 * 1024 * 1024;

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith(`..${sep}`) && leftToRight !== ".." && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== ".." && !isAbsolute(rightToLeft))
  );
}

export async function validateDiagnostics(
  response: GenerationResponse,
  outputDirectory: string,
): Promise<void> {
  const outputMetadata = await lstat(outputDirectory);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("diagnostic output root must be a real directory, not a symbolic link");
  }
  const artifactPaths = response.artifacts.map((artifact) =>
    resolveContained(outputDirectory, artifact.path, "diagnostic"),
  );
  const totalBytes = response.diagnostics.reduce(
    (sum, diagnostic) => sum + diagnostic.size_bytes,
    0,
  );
  if (totalBytes > MAXIMUM_AGGREGATE_DIAGNOSTIC_BYTES) {
    throw new Error(
      `diagnostics exceed the aggregate size limit of ${MAXIMUM_AGGREGATE_DIAGNOSTIC_BYTES} bytes: ${totalBytes} declared`,
    );
  }

  for (const diagnostic of response.diagnostics) {
    const path = resolveContained(outputDirectory, diagnostic.path, "diagnostic");
    if (artifactPaths.some((artifactPath) => overlaps(path, artifactPath))) {
      throw new Error(`diagnostic overlaps candidate artifacts: ${diagnostic.path}`);
    }
    await rejectSymlinkComponents(outputDirectory, path, "diagnostic");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`diagnostic must be a regular file: ${diagnostic.path}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`hard links are not allowed in diagnostics: ${diagnostic.path}`);
    }
    if (metadata.size !== diagnostic.size_bytes) {
      throw new Error(
        `diagnostic size does not match: ${diagnostic.path} (declared ${diagnostic.size_bytes} bytes, measured ${metadata.size} bytes)`,
      );
    }
    const journalBytes =
      diagnostic.kind === "event_journal" ? await readBytesBounded(path, metadata.size) : undefined;
    const digest =
      journalBytes === undefined ? await sha256File(path, metadata.size) : sha256(journalBytes);
    if (digest !== diagnostic.sha256) {
      throw new Error(
        `diagnostic digest does not match: ${diagnostic.path} (declared ${diagnostic.sha256}, computed ${digest})`,
      );
    }
    if (journalBytes !== undefined) {
      let contents: string;
      try {
        contents = new TextDecoder("utf-8", { fatal: true }).decode(journalBytes);
      } catch {
        throw new Error(`event journal is not valid UTF-8: ${diagnostic.path}`);
      }
      if (contents.length > 0 && !contents.endsWith("\n")) {
        throw new Error(`event journal has an incomplete final record: ${diagnostic.path}`);
      }
      const lines = contents.length === 0 ? [] : contents.slice(0, -1).split("\n");
      for (const line of lines) {
        if (line.length === 0) {
          throw new Error(`event journal contains an empty record: ${diagnostic.path}`);
        }
        try {
          JSON.parse(line);
        } catch {
          throw new Error(`event journal contains invalid JSON: ${diagnostic.path}`);
        }
      }
      if (lines.length !== diagnostic.record_count) {
        throw new Error(
          `event journal record count does not match: ${diagnostic.path} (declared ${diagnostic.record_count}, counted ${lines.length})`,
        );
      }
    }
  }
}
