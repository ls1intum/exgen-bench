import { describe, expect, test } from "bun:test";
import { EXGEN_VERSION } from "../src/version.ts";

describe("project version", () => {
  test("matches package metadata", async () => {
    const packageMetadata = (await Bun.file("package.json").json()) as { version: string };

    expect(packageMetadata.version).toBe(EXGEN_VERSION);
  });
});
