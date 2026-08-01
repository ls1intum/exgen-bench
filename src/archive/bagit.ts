import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildEvidenceManifest, digestFile, type FileDigests } from "../core/evidence.ts";
import { readTextBounded } from "../core/files.ts";

export interface RestrictedArchiveOptions {
  runDirectory: string;
  outputDirectory: string;
  identifier: string;
  retentionUntil: string;
  containsModelContent: boolean;
  createdAt?: string;
}

export interface RestrictedArchiveSummary {
  directory: string;
  identifier: string;
  files: number;
  bytes: number;
  manifest_sha256: string;
}

const MAXIMUM_TAG_BYTES = 64 * 1024;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024 * 1024;
const BAGIT_DECLARATION = "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n";
const PAYLOAD_PREFIX = "data/run/";
const MANIFEST_ALGORITHMS = { sha256: 64, sha512: 128 } as const;
const MANIFEST_ALGORITHM_NAMES = ["sha256", "sha512"] as const;
const FIXED_TAG_FILES = ["bag-info.txt", "bagit.txt", "exgen-archive.json"] as const;

type ManifestAlgorithm = (typeof MANIFEST_ALGORITHM_NAMES)[number];

interface ManifestRecord {
  digest: string;
  path: string;
}

interface DigestedFile {
  path: string;
  digests: FileDigests;
}

function validIdentifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("archive identifier must use 1-128 letters, digits, '.', '_' or '-'");
  }
  return value;
}

// RFC 8493 section 2.1.3 requires exactly these three substitutions.
function encodeManifestPath(path: string): string {
  return path.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function decodeManifestPath(path: string): string {
  return path.replace(/%(25|0[AD])/gi, (_match, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function line(path: string, digest: string): string {
  return `${digest}  ${encodeManifestPath(path)}\n`;
}

function validDate(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be an ISO calendar date`);
  }
  return value;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function collectAncestors(root: string, target: string, directories: Set<string>): void {
  let current = dirname(target);
  while (current.startsWith(root)) {
    directories.add(current);
    if (current === root) {
      return;
    }
    current = dirname(current);
  }
}

export async function createRestrictedArchive(
  options: RestrictedArchiveOptions,
): Promise<RestrictedArchiveSummary> {
  const runDirectory = resolve(options.runDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const identifier = validIdentifier(options.identifier);
  const retentionUntil = validDate(options.retentionUntil, "--retention-until");
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("the archive creation timestamp must be a canonical ISO timestamp");
  }
  const baggingDate = validDate(createdAt.slice(0, 10), "the archive creation timestamp");
  if (retentionUntil < baggingDate) {
    throw new Error(
      `--retention-until ${retentionUntil} cannot precede the archive creation date ${baggingDate}`,
    );
  }
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new Error(`archive output already exists: ${outputDirectory}`);
    }
    throw error;
  }
  // Staging beside the target keeps the publishing rename atomic and free of cross-device EXDEV.
  const temporary = await mkdtemp(join(dirname(outputDirectory), `.${basename(outputDirectory)}-`));
  let published = false;
  try {
    const source = await buildEvidenceManifest(runDirectory, undefined, {
      includeEvidenceManifest: true,
    });
    const payloadRoot = join(temporary, "data", "run");
    await mkdir(payloadRoot, { recursive: true, mode: 0o700 });
    const directories = new Set<string>([join(temporary, "data"), payloadRoot]);
    const payload: DigestedFile[] = [];
    for (const entry of source.files) {
      const manifestPath = `${PAYLOAD_PREFIX}${entry.path}`;
      safePayloadPath(manifestPath);
      const sourcePath = join(runDirectory, entry.path);
      const metadata = await lstat(sourcePath);
      if (!metadata.isFile() || metadata.nlink > 1 || metadata.size !== entry.size) {
        throw new Error(`run evidence changed while archiving: ${entry.path}`);
      }
      const target = join(payloadRoot, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      collectAncestors(payloadRoot, target, directories);
      await copyFile(sourcePath, target);
      await chmod(target, 0o600);
      const digests = await digestFile(target, entry.size);
      if (digests.sha256 !== entry.sha256) {
        throw new Error(
          `copied evidence digest mismatch: ${entry.path} (source ${entry.sha256}, copy ${digests.sha256})`,
        );
      }
      await syncPath(target);
      payload.push({ path: manifestPath, digests });
    }
    const bytes = source.files.reduce((sum, entry) => sum + entry.size, 0);
    await writeFile(join(temporary, "bagit.txt"), BAGIT_DECLARATION);
    // Payload-Oxum is "<octet count>.<stream count>" per RFC 8493 section 2.2.2.
    await writeFile(
      join(temporary, "bag-info.txt"),
      `Bagging-Date: ${baggingDate}\nExternal-Identifier: ${identifier}\nPayload-Oxum: ${bytes}.${source.files.length}\n`,
    );
    await writeFile(
      join(temporary, "exgen-archive.json"),
      `${JSON.stringify(
        {
          schema_version: "1",
          identifier,
          created_at: createdAt,
          classification: "restricted",
          retention_until: retentionUntil,
          contains_raw_model_content: options.containsModelContent,
          reasoning_content_policy: "provider_exposed_only",
          hidden_chain_of_thought: "not_collected",
          encryption: "required_at_rest_and_in_transit",
          payload: { files: source.files.length, bytes },
        },
        null,
        2,
      )}\n`,
    );
    for (const algorithm of MANIFEST_ALGORITHM_NAMES) {
      await writeFile(
        join(temporary, `manifest-${algorithm}.txt`),
        payload.map((entry) => line(entry.path, entry.digests[algorithm])).join(""),
      );
    }
    const tagFiles = [
      ...FIXED_TAG_FILES,
      ...MANIFEST_ALGORITHM_NAMES.map((algorithm) => `manifest-${algorithm}.txt`),
    ].sort();
    const tags: DigestedFile[] = [];
    for (const path of tagFiles) {
      await chmod(join(temporary, path), 0o600);
      await syncPath(join(temporary, path));
      tags.push({ path, digests: await digestFile(join(temporary, path)) });
    }
    for (const algorithm of MANIFEST_ALGORITHM_NAMES) {
      const tagManifest = join(temporary, `tagmanifest-${algorithm}.txt`);
      await writeFile(
        tagManifest,
        tags.map((entry) => line(entry.path, entry.digests[algorithm])).join(""),
      );
      await chmod(tagManifest, 0o600);
      await syncPath(tagManifest);
    }
    const payloadManifest = tags.find((entry) => entry.path === "manifest-sha256.txt");
    if (payloadManifest === undefined) {
      throw new Error("BagIt tag manifest is missing manifest-sha256.txt");
    }
    for (const directory of directories) {
      await syncPath(directory);
    }
    await syncPath(temporary);
    await rename(temporary, outputDirectory);
    published = true;
    await syncPath(dirname(outputDirectory));
    return {
      directory: outputDirectory,
      identifier,
      files: source.files.length,
      bytes,
      manifest_sha256: payloadManifest.digests.sha256,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (!published) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function parseManifest(value: string, algorithm: ManifestAlgorithm): ManifestRecord[] {
  if (value === "") {
    return [];
  }
  if (!value.endsWith("\n")) {
    throw new Error(`BagIt ${algorithm} manifest has an incomplete final record`);
  }
  const pattern = new RegExp(`^([A-Fa-f0-9]{${MANIFEST_ALGORITHMS[algorithm]}})[ \\t]+(.+)$`);
  return value
    .slice(0, -1)
    .split("\n")
    .map((record) => {
      const match = pattern.exec(record);
      if (!match?.[1] || !match[2]) {
        throw new Error(`BagIt ${algorithm} manifest contains an invalid record: ${record}`);
      }
      return { digest: match[1].toLowerCase(), path: decodeManifestPath(match[2]) };
    });
}

function traverses(path: string): boolean {
  return path.startsWith("/") || path.split(/[/\\]/).includes("..");
}

function safePayloadPath(path: string): void {
  if (!path.startsWith(PAYLOAD_PREFIX) || traverses(path)) {
    throw new Error(`unsafe BagIt manifest path: ${path}`);
  }
}

function safeTagPath(path: string): void {
  if (traverses(path) || path === "data" || path.startsWith("data/")) {
    throw new Error(`unsafe BagIt manifest path: ${path}`);
  }
}

function permittedRootEntry(entry: string): boolean {
  return (
    entry === "data" ||
    entry === "fetch.txt" ||
    (FIXED_TAG_FILES as readonly string[]).includes(entry) ||
    /^(tag)?manifest-[A-Za-z0-9_]+\.txt$/.test(entry)
  );
}

function supportedManifests(
  entries: string[],
  prefix: string,
): Array<{ entry: string; algorithm: ManifestAlgorithm }> {
  const manifests: Array<{ entry: string; algorithm: ManifestAlgorithm }> = [];
  for (const entry of entries) {
    const name = new RegExp(`^${prefix}-([A-Za-z0-9_]+)\\.txt$`).exec(entry)?.[1];
    for (const algorithm of MANIFEST_ALGORITHM_NAMES) {
      if (name === algorithm) {
        manifests.push({ entry, algorithm });
      }
    }
  }
  return manifests;
}

function describeInventoryDifference(declared: string[], present: string[]): string {
  const missing = declared.filter((path) => !present.includes(path));
  const undeclared = present.filter((path) => !declared.includes(path));
  return `missing ${JSON.stringify(missing.slice(0, 8))}, undeclared ${JSON.stringify(undeclared.slice(0, 8))}`;
}

export async function verifyRestrictedArchive(
  directoryInput: string,
): Promise<RestrictedArchiveSummary> {
  const directory = resolve(directoryInput);
  const rootMetadata = await lstat(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("BagIt archive root must be a directory, not a link");
  }
  const rootEntries = (await readdir(directory)).sort();
  for (const required of [...FIXED_TAG_FILES, "data", "manifest-sha256.txt"]) {
    if (!rootEntries.includes(required)) {
      throw new Error(`BagIt archive is missing a required entry: ${required}`);
    }
  }
  for (const entry of rootEntries) {
    if (!permittedRootEntry(entry)) {
      throw new Error(`BagIt archive contains an unexpected root entry: ${entry}`);
    }
  }
  if (!(await lstat(join(directory, "data"))).isDirectory()) {
    throw new Error("BagIt payload entry 'data' must be a directory");
  }
  const payloadManifests = supportedManifests(rootEntries, "manifest");
  const tagManifests = supportedManifests(rootEntries, "tagmanifest");
  if (tagManifests.length === 0) {
    throw new Error("BagIt archive has no tag manifest in a supported algorithm");
  }

  const digests = new Map<string, FileDigests>();
  const digestsOf = async (path: string): Promise<FileDigests> => {
    const cached = digests.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const computed = await digestFile(join(directory, path));
    digests.set(path, computed);
    return computed;
  };

  const requiredTags = [
    ...FIXED_TAG_FILES,
    ...payloadManifests.map((manifest) => manifest.entry),
  ].sort();
  for (const manifest of tagManifests) {
    const algorithm = manifest.algorithm;
    const entries = parseManifest(
      await readTextBounded(join(directory, manifest.entry), MAXIMUM_MANIFEST_BYTES, {
        rejectHardLinks: true,
      }),
      algorithm,
    );
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error(`BagIt tag manifest lists a duplicate path: ${manifest.entry}`);
    }
    for (const required of requiredTags) {
      if (!paths.includes(required)) {
        throw new Error(`BagIt tag manifest ${manifest.entry} does not declare ${required}`);
      }
    }
    for (const entry of entries) {
      safeTagPath(entry.path);
      const metadata = await lstat(join(directory, entry.path));
      // A second hard link leaves the verified bytes mutable through a path outside the archive.
      if (!metadata.isFile() || metadata.nlink > 1) {
        throw new Error(`BagIt tag is not an independent regular file: ${entry.path}`);
      }
      const computed = (await digestsOf(entry.path))[algorithm];
      if (computed !== entry.digest) {
        throw new Error(
          `BagIt tag digest mismatch: ${entry.path} (manifest ${entry.digest}, computed ${computed})`,
        );
      }
    }
  }

  const bagit = await readTextBounded(join(directory, "bagit.txt"), MAXIMUM_TAG_BYTES, {
    rejectHardLinks: true,
  });
  if (bagit !== BAGIT_DECLARATION) {
    throw new Error(
      `unsupported BagIt declaration: expected ${JSON.stringify(BAGIT_DECLARATION)}, found ${JSON.stringify(bagit)}`,
    );
  }
  const declaration = JSON.parse(
    await readTextBounded(join(directory, "exgen-archive.json"), MAXIMUM_TAG_BYTES, {
      rejectHardLinks: true,
    }),
  ) as {
    schema_version?: unknown;
    identifier?: unknown;
    created_at?: unknown;
    classification?: unknown;
    retention_until?: unknown;
    contains_raw_model_content?: unknown;
    reasoning_content_policy?: unknown;
    hidden_chain_of_thought?: unknown;
    encryption?: unknown;
    payload?: { files?: unknown; bytes?: unknown };
  };
  if (
    declaration.schema_version !== "1" ||
    typeof declaration.identifier !== "string" ||
    typeof declaration.created_at !== "string" ||
    declaration.classification !== "restricted" ||
    typeof declaration.retention_until !== "string" ||
    typeof declaration.contains_raw_model_content !== "boolean" ||
    declaration.reasoning_content_policy !== "provider_exposed_only" ||
    declaration.hidden_chain_of_thought !== "not_collected" ||
    declaration.encryption !== "required_at_rest_and_in_transit" ||
    !Number.isSafeInteger(declaration.payload?.files) ||
    !Number.isSafeInteger(declaration.payload?.bytes) ||
    (declaration.payload?.files as number) < 0 ||
    (declaration.payload?.bytes as number) < 0
  ) {
    throw new Error("invalid exgen restricted archive declaration");
  }
  validIdentifier(declaration.identifier);
  if (
    Number.isNaN(Date.parse(declaration.created_at)) ||
    new Date(declaration.created_at).toISOString() !== declaration.created_at
  ) {
    throw new Error("archive created_at must be a canonical ISO timestamp");
  }
  const declaredPayload = declaration.payload as { files: number; bytes: number };
  const retentionUntil = validDate(declaration.retention_until, "retention_until");
  const baggingDate = declaration.created_at.slice(0, 10);
  if (retentionUntil < baggingDate) {
    throw new Error(`retention_until ${retentionUntil} precedes created_at ${baggingDate}`);
  }

  const actual = await buildEvidenceManifest(join(directory, "data"), undefined, {
    includeEvidenceManifest: true,
  });
  const presentPaths = actual.files.map((entry) => `data/${entry.path}`).sort();
  for (const manifest of payloadManifests) {
    const algorithm = manifest.algorithm;
    const entries = parseManifest(
      await readTextBounded(join(directory, manifest.entry), MAXIMUM_MANIFEST_BYTES, {
        rejectHardLinks: true,
      }),
      algorithm,
    );
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error(`BagIt payload manifest contains a duplicate path: ${manifest.entry}`);
    }
    for (const entry of entries) {
      safePayloadPath(entry.path);
    }
    const declaredPaths = [...paths].sort();
    if (JSON.stringify(declaredPaths) !== JSON.stringify(presentPaths)) {
      throw new Error(
        `BagIt payload inventory does not match ${manifest.entry}: ${describeInventoryDifference(declaredPaths, presentPaths)}`,
      );
    }
    for (const entry of entries) {
      const computed = (await digestsOf(entry.path))[algorithm];
      if (computed !== entry.digest) {
        throw new Error(
          `BagIt payload digest mismatch: ${entry.path} (manifest ${entry.digest}, computed ${computed})`,
        );
      }
    }
  }

  const bytes = actual.files.reduce((sum, entry) => sum + entry.size, 0);
  if (actual.files.length !== declaredPayload.files || bytes !== declaredPayload.bytes) {
    throw new Error(
      `BagIt payload totals do not match the archive declaration: declared ${declaredPayload.files} files and ${declaredPayload.bytes} bytes, found ${actual.files.length} files and ${bytes} bytes`,
    );
  }
  const bagInfo = await readTextBounded(join(directory, "bag-info.txt"), MAXIMUM_TAG_BYTES, {
    rejectHardLinks: true,
  });
  const expectedBagInfo = `Bagging-Date: ${baggingDate}\nExternal-Identifier: ${declaration.identifier}\nPayload-Oxum: ${bytes}.${actual.files.length}\n`;
  if (bagInfo !== expectedBagInfo) {
    throw new Error(
      `BagIt info does not match the archive declaration: expected ${JSON.stringify(expectedBagInfo)}, found ${JSON.stringify(bagInfo)}`,
    );
  }
  const manifestDigests = digests.get("manifest-sha256.txt");
  if (manifestDigests === undefined) {
    throw new Error("BagIt archive is missing a required entry: manifest-sha256.txt");
  }
  return {
    directory,
    identifier: declaration.identifier,
    files: actual.files.length,
    bytes,
    manifest_sha256: manifestDigests.sha256,
  };
}
