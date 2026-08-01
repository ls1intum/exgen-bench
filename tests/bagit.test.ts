import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestrictedArchive, verifyRestrictedArchive } from "../src/archive/bagit.ts";
import { sha256File } from "../src/core/evidence.ts";

const temporaryDirectories: string[] = [];

const TAG_FILES = [
  "bag-info.txt",
  "bagit.txt",
  "exgen-archive.json",
  "manifest-sha256.txt",
  "manifest-sha512.txt",
];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-bagit-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, "manifest.json"), '{"run_id":"test"}\n');
  await writeFile(join(directory, "ledger.sqlite"), "test ledger\n");
  return directory;
}

async function createArchive(run: string, output: string) {
  return createRestrictedArchive({
    runDirectory: run,
    outputDirectory: output,
    identifier: "test-run",
    retentionUntil: "2027-07-31",
    containsModelContent: true,
    createdAt: "2026-07-31T12:00:00.000Z",
  });
}

async function resignTagManifests(output: string): Promise<void> {
  for (const algorithm of ["sha256", "sha512"] as const) {
    let contents = "";
    for (const tag of TAG_FILES) {
      const hasher = new Bun.CryptoHasher(algorithm);
      hasher.update(await readFile(join(output, tag)));
      contents += `${hasher.digest("hex")}  ${tag}\n`;
    }
    await writeFile(join(output, `tagmanifest-${algorithm}.txt`), contents);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("restricted BagIt archives", () => {
  test("creates and verifies a complete restricted archive", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await runDirectory();
    await writeFile(join(run, "filename-with-trailing-space "), "preserved\n");
    const created = await createArchive(run, output);
    const verified = await verifyRestrictedArchive(output);

    expect(verified).toEqual(created);
    expect(created.files).toBe(3);
    expect(JSON.parse(await readFile(join(output, "exgen-archive.json"), "utf8"))).toMatchObject({
      classification: "restricted",
      contains_raw_model_content: true,
      reasoning_content_policy: "provider_exposed_only",
      hidden_chain_of_thought: "not_collected",
      encryption: "required_at_rest_and_in_transit",
    });
  });

  test("never omits the SHA-512 manifest RFC 8493 section 2.4 asks tools to enable by default", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);

    const payloadSha512 = await readFile(join(output, "manifest-sha512.txt"), "utf8");
    const payloadSha256 = await readFile(join(output, "manifest-sha256.txt"), "utf8");
    expect(payloadSha512.split("\n").filter(Boolean)).toHaveLength(2);
    for (const record of payloadSha512.split("\n").filter(Boolean)) {
      expect(record).toMatch(/^[a-f0-9]{128} {2}data\/run\/[^\n]+$/);
    }
    expect(payloadSha512.split("\n").map((record) => record.slice(129))).toEqual(
      payloadSha256.split("\n").map((record) => record.slice(65)),
    );
    expect(await readFile(join(output, "tagmanifest-sha512.txt"), "utf8")).toContain(
      "  manifest-sha256.txt\n",
    );
  });

  test("writes a spec-literal bag-info.txt for a known payload", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await temporaryDirectory();
    await writeFile(join(run, "a.txt"), "aaaaaaaaaaa\n");
    await writeFile(join(run, "b.txt"), "bbbbbbbbbbb\n");
    await createArchive(run, output);

    expect(await readFile(join(output, "bag-info.txt"), "utf8")).toBe(
      "Bagging-Date: 2026-07-31\nExternal-Identifier: test-run\nPayload-Oxum: 24.2\n",
    );
  });

  test("never writes a byte-order mark or a wrong version into bagit.txt", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);

    const declaration = await readFile(join(output, "bagit.txt"));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(declaration)).toBe(
      "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n",
    );
    expect(declaration[0]).not.toBe(0xef);
  });

  test("keeps every archived file readable only by its owner", async () => {
    const previousUmask = process.umask(0o022);
    try {
      const parent = await temporaryDirectory();
      const output = join(parent, "archive");
      await createArchive(await runDirectory(), output);

      expect((await stat(output)).mode & 0o777).toBe(0o700);
      for (const tag of [...TAG_FILES, "tagmanifest-sha256.txt", "tagmanifest-sha512.txt"]) {
        expect((await stat(join(output, tag))).mode & 0o777).toBe(0o600);
      }
      expect((await stat(join(output, "data", "run", "ledger.sqlite"))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("detects payload tampering", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    await writeFile(join(output, "data", "run", "ledger.sqlite"), "changed\n");

    await expect(verifyRestrictedArchive(output)).rejects.toThrow("payload digest mismatch");
  });

  test("detects a payload manifest that only its SHA-512 records contradict", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    const manifestPath = join(output, "manifest-sha512.txt");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, `${"0".repeat(128)}${manifest.slice(128)}`);
    await resignTagManifests(output);

    await expect(verifyRestrictedArchive(output)).rejects.toThrow("payload digest mismatch");
  });

  test("detects a tag file edited after the bag was written", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    const declarationPath = join(output, "exgen-archive.json");
    const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
    declaration.contains_raw_model_content = false;
    await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);

    await expect(verifyRestrictedArchive(output)).rejects.toThrow(
      "tag digest mismatch: exgen-archive.json",
    );
  });

  test("detects a declaration whose payload totals were re-signed to a lie", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    const declarationPath = join(output, "exgen-archive.json");
    const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
    declaration.payload = { files: 99, bytes: 12_345 };
    await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);
    await resignTagManifests(output);

    await expect(verifyRestrictedArchive(output)).rejects.toThrow(
      "payload totals do not match the archive declaration: declared 99 files and 12345 bytes, found 2 files and 30 bytes",
    );
  });

  test("never writes a payload path its own verifier rejects", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await temporaryDirectory();
    await writeFile(join(run, "windows\\style.txt"), "backslash\n");
    const created = await createArchive(run, output);

    expect(await readFile(join(output, "manifest-sha256.txt"), "utf8")).toContain(
      "  data/run/windows\\style.txt\n",
    );
    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("rejects a backslash-separated traversal on both the create and verify paths", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await temporaryDirectory();
    await writeFile(join(run, "..\\..\\escape.txt"), "traversal\n");

    await expect(createArchive(run, join(parent, "rejected"))).rejects.toThrow(
      "unsafe BagIt manifest path: data/run/..\\..\\escape.txt",
    );

    await createArchive(await runDirectory(), output);
    for (const algorithm of ["sha256", "sha512"] as const) {
      const manifestPath = join(output, `manifest-${algorithm}.txt`);
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        manifest.replace("data/run/ledger.sqlite", "data/run/..\\..\\escape.txt"),
      );
    }
    await resignTagManifests(output);

    await expect(verifyRestrictedArchive(output)).rejects.toThrow("unsafe BagIt manifest path");
  });

  test("rejects traversal in a correctly checksummed manifest", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    for (const algorithm of ["sha256", "sha512"] as const) {
      const manifestPath = join(output, `manifest-${algorithm}.txt`);
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        manifest.replace("data/run/ledger.sqlite", "data/run/../secret"),
      );
    }
    await resignTagManifests(output);

    await expect(verifyRestrictedArchive(output)).rejects.toThrow("unsafe BagIt manifest path");
  });

  test("rejects an undeclared payload file smuggled in as data/evidence-manifest.json", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    await writeFile(join(output, "data", "evidence-manifest.json"), '{"smuggled":true}\n');

    await expect(verifyRestrictedArchive(output)).rejects.toThrow(
      "payload inventory does not match",
    );
  });

  test("never drops a run-root evidence-manifest.json from the payload", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await runDirectory();
    await writeFile(join(run, "evidence-manifest.json"), '{"schema_version":"1","files":[]}\n');
    const created = await createArchive(run, output);

    expect(created.files).toBe(3);
    expect(await readFile(join(output, "manifest-sha256.txt"), "utf8")).toContain(
      "  data/run/evidence-manifest.json\n",
    );
    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("round-trips a run with no files at all", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const created = await createArchive(await temporaryDirectory(), output);

    expect(created.files).toBe(0);
    expect(created.bytes).toBe(0);
    expect(await readFile(join(output, "manifest-sha256.txt"), "utf8")).toBe("");
    expect(await readFile(join(output, "bag-info.txt"), "utf8")).toContain("Payload-Oxum: 0.0\n");
    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("percent-encodes a payload path containing a literal percent sign", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await temporaryDirectory();
    await writeFile(join(run, "log%0Aone.txt"), "encoded\n");
    const created = await createArchive(run, output);

    const manifest = await readFile(join(output, "manifest-sha256.txt"), "utf8");
    expect(manifest).toContain("  data/run/log%250Aone.txt\n");
    expect(manifest).not.toContain("  data/run/log%0Aone.txt\n");
    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("percent-encodes rather than rejecting a payload path containing a line feed", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const run = await temporaryDirectory();
    await writeFile(join(run, "log\none.txt"), "encoded\n");
    const created = await createArchive(run, output);

    expect(await readFile(join(output, "manifest-sha256.txt"), "utf8")).toBe(
      `${await sha256File(join(output, "data", "run", "log\none.txt"))}  data/run/log%0Aone.txt\n`,
    );
    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("accepts the uppercase hex and tab separator RFC 8493 section 2.1.3 permits", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const created = await createArchive(await runDirectory(), output);
    const manifestPath = join(output, "manifest-sha256.txt");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifest
        .split("\n")
        .map((record) =>
          record === "" ? record : `${record.slice(0, 64).toUpperCase()}\t${record.slice(66)}`,
        )
        .join("\n"),
    );
    await resignTagManifests(output);

    await expect(verifyRestrictedArchive(output)).resolves.toMatchObject({
      files: created.files,
      bytes: created.bytes,
    });
  });

  test("accepts the optional fetch.txt and extra algorithm manifests RFC 8493 allows", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    const created = await createArchive(await runDirectory(), output);
    await writeFile(join(output, "fetch.txt"), "");
    await writeFile(join(output, "manifest-md5.txt"), "");

    await expect(verifyRestrictedArchive(output)).resolves.toEqual(created);
  });

  test("rejects an unexpected root entry", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "archive");
    await createArchive(await runDirectory(), output);
    await writeFile(join(output, "notes.txt"), "smuggled\n");

    await expect(verifyRestrictedArchive(output)).rejects.toThrow("unexpected root entry");
  });

  test("rejects a run directory containing a symbolic link", async () => {
    const run = await runDirectory();
    await symlink(join(run, "manifest.json"), join(run, "linked.json"));
    const parent = await temporaryDirectory();

    await expect(createArchive(run, join(parent, "linked"))).rejects.toThrow("symbolic link");
  });

  test("rejects a retention date that is not a calendar date", async () => {
    const parent = await temporaryDirectory();

    await expect(
      createRestrictedArchive({
        runDirectory: await runDirectory(),
        outputDirectory: join(parent, "invalid-date"),
        identifier: "test-run",
        retentionUntil: "2027-02-30",
        containsModelContent: false,
      }),
    ).rejects.toThrow("--retention-until must be an ISO calendar date");
  });

  test("rejects an output directory that already exists", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "existing");
    await createArchive(await runDirectory(), output);

    await expect(createArchive(await runDirectory(), output)).rejects.toThrow("already exists");
  });
});
