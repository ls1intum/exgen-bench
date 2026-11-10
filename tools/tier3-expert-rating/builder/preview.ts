import { join, relative, resolve, sep } from "node:path";

import type { PreviewEntry, PreviewExercise, PreviewList, Site } from "../shared/api.ts";
import { exerciseTitle, type ExerciseView } from "../shared/exercise.ts";
import { materialThrough } from "../shared/instrument.ts";
import {
  checkStudy,
  EXERCISES_DIRECTORY,
  type LoadedStudy,
  loadStudy,
  MANIFEST_FILE,
  type ManifestEntry,
  type StudyReport,
} from "./study.ts";

/**
 * `exgen survey preview`: the study team reviews every frozen exercise as raters will see it before
 * the survey server freezes the study into its database. It serves the browser app's preview page
 * and the two read-only endpoints the server has behind the study team's link
 * (exgen.survey.web.PreviewController), from the built files on disk, verified as the server
 * verifies them. Nothing is recorded, there is no database, and it listens on 127.0.0.1 only.
 */

/** The server's policy (exgen.survey.web.SecurityConfiguration), so the preview renders as served. */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};

/**
 * A built study, verified like `exgen survey check` and the server verify it: every exercise file
 * must match its frozen digest and this version's format. An unbuilt study is refused, since there
 * is nothing to preview; the check's problems and warnings are returned for the caller to report.
 */
export async function loadPreview(
  directory: string,
): Promise<{ loaded: LoadedStudy; report: StudyReport }> {
  const root = resolve(directory);
  if (!(await Bun.file(join(root, EXERCISES_DIRECTORY, MANIFEST_FILE)).exists())) {
    throw new Error(`the exercises are not built yet; run exgen survey build ${root} first`);
  }
  const loaded = await loadStudy(root);
  return { loaded, report: checkStudy(loaded) };
}

function entryOf(loaded: LoadedStudy, entry: ManifestEntry): PreviewEntry {
  const exercise = loaded.exercises.get(entry.code);
  return {
    code: entry.code,
    id: entry.id,
    phase: entry.phase,
    title: exercise === undefined ? null : exerciseTitle(exercise.statement),
    // Only the case: the run, attempt and system can name the generator.
    case: entry.source.case_id,
  };
}

export function previewList(loaded: LoadedStudy): PreviewList {
  return {
    study: { id: loaded.study.id, title: loaded.study.title },
    deployed: false,
    parts: loaded.instrument.questionnaire.parts.map((part) => ({
      id: part.id,
      title: part.title,
      opens: part.opens,
      material: [...part.material],
    })),
    exercises: loaded.manifest.exercises
      .filter((entry) => loaded.exercises.has(entry.code))
      .map((entry) => entryOf(loaded, entry)),
  };
}

export function previewExercise(loaded: LoadedStudy, code: string): PreviewExercise | undefined {
  const entry = loaded.manifest.exercises.find((candidate) => candidate.code === code);
  const exercise = entry === undefined ? undefined : loaded.exercises.get(code);
  if (entry === undefined || exercise === undefined) return undefined;
  const last = loaded.instrument.questionnaire.parts.at(-1);
  // The view of the last part's step, as the server cuts it (LoadedStudy.viewOf).
  const view: ExerciseView = { id: exercise.id, phase: exercise.phase, facts: exercise.facts };
  for (const material of last === undefined ? [] : materialThrough(loaded.instrument, last.id)) {
    Object.assign(view, { [material]: exercise[material] });
  }
  return { ...entryOf(loaded, entry), sha256: entry.sha256, exercise: view };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store" },
  });
}

/**
 * The preview's request handling: the two preview endpoints, the footer's `/api/site`, the browser
 * app's assets, and its page for every other path. Requests must name this server as their host,
 * so a web page elsewhere cannot read the material through a rebound domain name.
 */
export function previewHandler(
  loaded: LoadedStudy,
  web: string,
): (request: Request, port: number) => Promise<Response> {
  const root = resolve(web);
  const assets = join(root, "assets");
  const site: Site = { legal: [], contact: loaded.study.contact };
  const list = previewList(loaded);
  return async (request, port) => {
    const host = request.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return new Response("Unknown host", { status: 421 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "the preview is read-only" }, 405);
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Malformed URL", { status: 400 });
    }
    if (path === "/api/admin/preview") return json(list);
    const code = /^\/api\/admin\/preview\/([^/]+)$/.exec(path)?.[1];
    if (code !== undefined) {
      const exercise = previewExercise(loaded, code);
      return exercise === undefined ? json({ error: "no such exercise" }, 404) : json(exercise);
    }
    if (path === "/api/site") return json(site);
    if (path.startsWith("/api/")) return json({ error: "no such endpoint" }, 404);
    if (path.startsWith("/assets/")) {
      const file = resolve(root, `.${path}`);
      const inside = relative(assets, file);
      if (inside === "" || inside.startsWith(`..${sep}`) || inside === "..") {
        return new Response("Not found", { status: 404 });
      }
      const body = Bun.file(file);
      if (!(await body.exists())) return new Response("Not found", { status: 404 });
      return new Response(body, {
        headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    return new Response(Bun.file(join(root, "index.html")), {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  };
}

/** The current build of the browser app; Vite is loaded only when it must rebuild. */
async function currentWeb(): Promise<string> {
  const { currentSurveyWeb } = await import("../web/build.ts");
  return currentSurveyWeb();
}

export interface PreviewServer {
  url: string;
  report: StudyReport;
  loaded: LoadedStudy;
  stop: () => Promise<void>;
}

/**
 * Serve the preview of a built study on 127.0.0.1. `web` is the built browser app; by default the
 * current build, rebuilt when its sources changed. Port 0 picks a free port.
 */
export async function servePreview(
  directory: string,
  options: { port: number; web?: string },
): Promise<PreviewServer> {
  const { loaded, report } = await loadPreview(directory);
  const web = options.web ?? (await currentWeb());
  if (!(await Bun.file(join(web, "index.html")).exists())) {
    throw new Error(`the browser app is not built at ${web}; run bun run survey:web`);
  }
  const handle = previewHandler(loaded, web);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: (request, current) => handle(request, current.port ?? options.port),
  });
  return {
    url: `http://127.0.0.1:${server.port}/preview`,
    report,
    loaded,
    stop: () => server.stop(true),
  };
}
