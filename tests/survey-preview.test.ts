import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse, stringify } from "yaml";

import { sha256 } from "../src/core/canonical.ts";
import {
  loadPreview,
  previewHandler,
  servePreview,
} from "../tools/tier3-expert-rating/builder/preview.ts";
import type { LoadedStudy } from "../tools/tier3-expert-rating/builder/study.ts";
import type { PreviewExercise, PreviewList } from "../tools/tier3-expert-rating/shared/api.ts";

/** The survey server's fixture: the demo study as built, with its frozen manifest. */
const FIXTURE = resolve("tools/tier3-expert-rating/server/src/test/resources/study");
const PORT = 4190;

let directory: string;
let study: string;
let web: string;
let loaded: LoadedStudy;
let handle: (request: Request, port: number) => Promise<Response>;

function get(path: string, init: RequestInit = {}, host = `127.0.0.1:${PORT}`) {
  return handle(
    new Request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } }),
    PORT,
  );
}

/** Every file under a directory with its digest, size and modification time. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const info = await stat(join(root, path));
    files[path] = info.isFile()
      ? `${sha256(await readFile(join(root, path)))} ${info.size} ${info.mtimeMs}`
      : `directory ${info.mtimeMs}`;
  }
  return files;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "exgen-survey-preview-"));
  study = join(directory, "study");
  await cp(FIXTURE, study, { recursive: true });
  web = join(directory, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(join(web, "assets", "app.js"), "console.log('app');");
  ({ loaded } = await loadPreview(study));
  handle = previewHandler(loaded, web);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("survey preview", () => {
  test("refuses a study whose exercises are not built", async () => {
    const unbuilt = join(directory, "unbuilt");
    await mkdir(unbuilt);
    await cp(join(FIXTURE, "study.yaml"), join(unbuilt, "study.yaml"));
    await expect(loadPreview(unbuilt)).rejects.toThrow("the exercises are not built yet");
    await expect(servePreview(unbuilt, { port: 0, web })).rejects.toThrow("not built yet");
  });

  test("refuses an exercise file that changed after it was frozen", async () => {
    const edited = join(directory, "edited");
    await cp(FIXTURE, edited, { recursive: true });
    const file = join(edited, "exercises", `${loaded.idOf.get("M1")}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace("{", "{ "));
    await expect(loadPreview(edited)).rejects.toThrow("exercise M1");
    await expect(loadPreview(edited)).rejects.toThrow("changed after it was built");
  });

  test("refuses a study the server would refuse, such as one with a built exercise it no longer names", async () => {
    const stale = join(directory, "stale");
    await cp(FIXTURE, stale, { recursive: true });
    const definition = parse(await readFile(join(stale, "study.yaml"), "utf8")) as {
      exercises: Array<{ code: string }>;
      raters: Array<{ exercises?: string[] }>;
    };
    definition.exercises = definition.exercises.filter((entry) => entry.code !== "L1");
    for (const rater of definition.raters) {
      rater.exercises = (rater.exercises ?? []).filter((code) => code !== "L1");
    }
    await writeFile(join(stale, "study.yaml"), stringify(definition));
    await expect(loadPreview(stale)).rejects.toThrow(
      "problem: built exercises are no longer in study.yaml: L1",
    );
    await expect(servePreview(stale, { port: 0, web })).rejects.toThrow(
      "the survey server would refuse to serve this study",
    );
  });

  test("lists the frozen exercises with code, phase, title and case, never the generator", async () => {
    const response = await get("/api/admin/preview");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("demo-generator");
    expect(text).not.toContain("survey-demo");
    const list = JSON.parse(text) as PreviewList;
    expect(list.study.id).toBe("expert-rating-demo");
    expect(list.deployed).toBe(false);
    expect(list.parts.map((part) => part.id)).toEqual(["A", "B", "C", "D"]);
    expect(list.parts.flatMap((part) => part.material)).toEqual([
      "statement",
      "brief",
      "template",
      "diff",
      "tests",
      "findings",
    ]);
    expect(list.exercises).toEqual([
      {
        code: "E1",
        id: loaded.idOf.get("E1") ?? "",
        phase: "early",
        title: "Step Statistics",
        case: "step-statistics",
      },
      expect.objectContaining({ code: "M1", phase: "middle", case: "library-loans" }),
      expect.objectContaining({ code: "L1", phase: "late" }),
    ]);
  });

  test("serves an exercise's whole frozen material in the shape the rating steps render", async () => {
    const response = await get("/api/admin/preview/E1");
    expect(response.status).toBe(200);
    const preview = (await response.json()) as PreviewExercise;
    const id = loaded.idOf.get("E1") ?? "";
    const frozen = JSON.parse(
      await readFile(join(study, "exercises", `${id}.json`), "utf8"),
    ) as Record<string, unknown>;
    const { schema_version: _version, ...view } = frozen;
    expect(preview.exercise as unknown).toEqual(view);
    expect(preview.sha256).toBe(
      loaded.manifest.exercises.find((entry) => entry.code === "E1")?.sha256 ?? "",
    );
    expect((await get("/api/admin/preview/Z9")).status).toBe(404);
  });

  test("is read-only, answers only to its own host, and serves the app inside its directory", async () => {
    expect((await get("/api/admin/preview", { method: "POST" })).status).toBe(405);
    expect((await get("/api/admin/preview", {}, `evil.example:${PORT}`)).status).toBe(421);
    expect((await get("/api/admin/preview", {}, "127.0.0.1:1")).status).toBe(421);
    expect((await get("/api/step/open")).status).toBe(404);
    const site = await (await get("/api/site")).json();
    expect(site).toEqual({ legal: [], contact: loaded.study.contact });

    expect(await (await get("/assets/app.js")).text()).toBe("console.log('app');");
    expect((await get("/assets/missing.js")).status).toBe(404);
    // Encoded slashes survive URL parsing; once decoded, the path leaves the app's directory.
    expect((await get("/assets/..%2F..%2Fstudy%2Fstudy.yaml")).status).toBe(404);
    const page = await get("/preview/E1");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("<title>app</title>");
  });

  test("writes nothing to the study directory while it serves", async () => {
    const before = await snapshot(study);
    const preview = await servePreview(study, { port: 0, web });
    try {
      const base = new URL(preview.url).origin;
      const paths = [
        "/preview",
        "/preview/E1",
        "/api/site",
        "/api/admin/preview",
        ...[...loaded.idOf.keys()].map((code) => `/api/admin/preview/${code}`),
        "/assets/app.js",
      ];
      for (const path of paths) {
        expect((await fetch(`${base}${path}`)).status).toBe(200);
      }
      expect((await fetch(`${base}/api/step/submit`, { method: "POST", body: "{}" })).status).toBe(
        405,
      );
    } finally {
      await preview.stop();
    }
    expect(Object.keys(before).length).toBeGreaterThan(3);
    expect(await snapshot(study)).toEqual(before);
  });

  test("listens on 127.0.0.1 only", async () => {
    const preview = await servePreview(study, { port: 0, web });
    try {
      expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+\/preview$/);
      const port = new URL(preview.url).port;
      const list = (await (
        await fetch(`http://127.0.0.1:${port}/api/admin/preview`)
      ).json()) as PreviewList;
      expect(list.exercises.map((entry) => entry.code)).toEqual(["E1", "M1", "L1"]);
      const external = Object.values(networkInterfaces())
        .flat()
        .find((address) => address?.family === "IPv4" && !address.internal)?.address;
      if (external !== undefined) {
        await expect(fetch(`http://${external}:${port}/api/admin/preview`)).rejects.toThrow();
      }
    } finally {
      await preview.stop();
    }
  });
});
