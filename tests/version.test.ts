import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { EXGEN_VERSION } from "../src/version.ts";

describe("project version", () => {
  test("matches package and citation metadata", async () => {
    const packageMetadata = (await Bun.file("package.json").json()) as { version: string };
    const citationMetadata = parse(await Bun.file("CITATION.cff").text()) as { version: string };

    expect(packageMetadata.version).toBe(EXGEN_VERSION);
    expect(citationMetadata.version).toBe(EXGEN_VERSION);
  });
});
