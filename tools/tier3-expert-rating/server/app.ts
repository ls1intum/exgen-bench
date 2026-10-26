import { join, normalize, resolve } from "node:path";

import type { BunRequest, Server } from "bun";
import { z } from "zod";

import { toCsv } from "../../../src/export/serialize.ts";
import {
  type AdminOverview,
  answersRequestSchema,
  assignRequestSchema,
  consentRequestSchema,
  deadlineRequestSchema,
  eventsRequestSchema,
  linkRequestSchema,
  type ProgressSegment,
  type Session,
  stepRequestSchema,
  type StepView,
} from "../shared/api.ts";
import { type Exercise, viewOf } from "../shared/exercise.ts";
import { PARTS, type Step, stepKey } from "../shared/flow.ts";
import {
  answerIssues,
  type Item,
  MATERIAL,
  materialThrough,
  normalizeAnswers,
  type PartId,
  type SectionAnswers,
  sectionAnswersSchema,
} from "../shared/instrument.ts";
import { readinessClass } from "../shared/readiness.ts";
import { exportArchive, raterExport } from "./export.ts";
import { type AssignmentRow, type RaterRow, StepConflict, SurveyStore } from "./store.ts";
import type { LoadedStudy } from "./study.ts";

/**
 * The survey server. A rater's browser holds a session cookie in place of their personal link and
 * receives a step's material only when it opens that step, which it can only do after every earlier
 * step is stored. Later material therefore never reaches the browser early, whatever the browser does.
 */

const COOKIE = "exgen_survey";

/**
 * Scripts and style sheets come only from this server. Inline style attributes are allowed, and
 * nothing else inline: PlantUML's engine sets them on the SVG it assembles in the page, they
 * cannot run code, statement HTML loses its own style attributes to the sanitizer, and `img-src`
 * keeps any URL in them on this server.
 */
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Add the security headers a route has not set itself, such as a diagram's sandbox policy. */
function secured(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) {
      response.headers.set(name, value);
    }
  }
  return response;
}

export interface SurveyServerOptions {
  loaded: LoadedStudy;
  store: SurveyStore;
  /** The built browser app. */
  web: string;
  port?: number;
  hostname?: string;
  /** Send the session cookie only over HTTPS; off for a local preview over plain HTTP. */
  secureCookies?: boolean;
}

export function serveSurvey(options: SurveyServerOptions): Server<undefined> {
  const { loaded, store } = options;
  const { study, instrument } = loaded;
  const web = resolve(options.web);
  const secure = options.secureCookies ?? true;
  const questionnaireItems = (part: PartId): Item[] =>
    instrument.questionnaire.parts.find((candidate) => candidate.id === part)?.items ?? [];

  const holderOf = (request: BunRequest) => {
    const token = request.cookies.get(COOKIE);
    return token === null ? null : store.holderOf(token);
  };

  const raterOf = (request: BunRequest): RaterRow => {
    const holder = holderOf(request);
    if (holder?.kind !== "rater") {
      throw new HttpError(401, "open your personal link to continue");
    }
    return holder.rater;
  };

  const requireAdmin = (request: BunRequest) => {
    if (holderOf(request)?.kind !== "admin") {
      throw new HttpError(401, "the study team's link is required");
    }
  };

  /**
   * Mutations must come from this host as JSON, on top of the SameSite=Strict cookie. The check
   * compares hosts, not origins, because behind a TLS-terminating proxy the server sees plain HTTP.
   */
  const readBody = async <T>(request: BunRequest, schema: z.ZodType<T>): Promise<T> => {
    const origin = request.headers.get("origin");
    if (origin === null || URL.parse(origin)?.host !== request.headers.get("host")) {
      throw new HttpError(403, "cross-origin request refused");
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new HttpError(415, "expected JSON");
    }
    const parsed = schema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      throw new HttpError(400, z.prettifyError(parsed.error));
    }
    return parsed.data;
  };

  const exerciseAt = (rater: RaterRow, position: number): Exercise => {
    const code = store.assignments(rater.id).find((row) => row.position === position)?.exercise;
    const exercise = code === undefined ? undefined : loaded.exercises.get(code);
    if (exercise === undefined) {
      throw new HttpError(404, "no exercise at this position");
    }
    return exercise;
  };

  const calibrationMaterial = MATERIAL.filter((material) => material !== "findings");

  const itemsOf = (step: Step): Item[] => {
    switch (step.kind) {
      case "background":
        return instrument.background.items;
      case "exit":
        return instrument.exit.items;
      case "calibration":
        return instrument.calibration.items;
      case "part":
        return questionnaireItems(step.part);
      default:
        return [];
    }
  };

  /** A step's draft, without answers to items the instrument no longer asks in that step. */
  const draftOf = (raterId: string, step: Step): SectionAnswers => {
    const draft = store.step(raterId, stepKey(step))?.draft;
    const items = new Set(itemsOf(step).map((item) => item.id));
    return draft == null
      ? {}
      : Object.fromEntries(
          Object.entries(sectionAnswersSchema.parse(JSON.parse(draft))).filter(([item]) =>
            items.has(item),
          ),
        );
  };

  const answersOf = (raterId: string, key: string): SectionAnswers => {
    const answers = store.step(raterId, key)?.answers;
    return answers == null ? {} : sectionAnswersSchema.parse(JSON.parse(answers));
  };

  const progressOf = (rater: RaterRow, step: Step): ProgressSegment[] => {
    const positions = store.assignments(rater.id).map((row) => row.position);
    const submitted = store.progress(rater).submitted;
    const segments: Array<{ label: string; done: boolean; current: boolean }> = [
      ["Consent", "consent"],
      ["Background", "background"],
      ["Introduction", "onboarding"],
      ["Practice", "calibration_review"],
    ].map(([label, key]) => ({
      label: label as string,
      done: submitted.has(key as string),
      current: step.kind === key || (key === "calibration_review" && step.kind === "calibration"),
    }));
    positions.forEach((position, index) => {
      segments.push({
        label: `Exercise ${index + 1}`,
        done: submitted.has(stepKey({ kind: "part", position, part: "D" })),
        current: step.kind === "part" && step.position === position,
      });
    });
    segments.push({
      label: "Final survey",
      done: submitted.has("exit"),
      current: step.kind === "exit",
    });
    return segments.map((segment) => ({
      label: segment.label,
      state: segment.current ? "current" : segment.done ? "done" : "todo",
    }));
  };

  const stepView = (rater: RaterRow, step: Step): StepView => {
    const key = stepKey(step);
    const opened = store.step(rater.id, key)?.opened_at != null;
    switch (step.kind) {
      case "consent":
        return { kind: "consent", ...study.consent };
      case "background":
      case "exit":
        return { kind: step.kind, key, draft: draftOf(rater.id, step) };
      case "onboarding":
        return { kind: "onboarding", key };
      case "calibration": {
        const exercise = loaded.exercises.get(study.calibration.code);
        return {
          kind: "calibration",
          key,
          opened,
          draft: draftOf(rater.id, step),
          ...(opened && exercise !== undefined
            ? { exercise: viewOf(exercise, calibrationMaterial) }
            : {}),
        };
      }
      case "calibration_review":
        return {
          kind: "calibration_review",
          key,
          answers: answersOf(rater.id, "calibration"),
          reference: study.calibration.reference,
        };
      case "part": {
        const positions = store.assignments(rater.id).map((row) => row.position);
        const earlier = Object.fromEntries(
          PARTS.slice(0, PARTS.indexOf(step.part)).map((part) => [
            part,
            answersOf(rater.id, stepKey({ kind: "part", position: step.position, part })),
          ]),
        );
        return {
          kind: "part",
          key,
          position: positions.indexOf(step.position) + 1,
          total: positions.length,
          part: step.part,
          opened,
          earlier,
          draft: draftOf(rater.id, step),
          ...(opened
            ? {
                exercise: viewOf(
                  exerciseAt(rater, step.position),
                  materialThrough(instrument, step.part),
                ),
              }
            : {}),
        };
      }
      default:
        return { kind: step.kind };
    }
  };

  const sessionOf = (request: BunRequest): Session => {
    const holder = holderOf(request);
    if (holder === null) {
      throw new HttpError(401, "open your personal link to continue");
    }
    if (holder.kind === "admin") {
      return { kind: "admin", study: { title: study.title } };
    }
    const rater = store.rater(holder.rater.id) ?? holder.rater;
    const step = store.current(rater);
    return {
      kind: "rater",
      study: { title: study.title, contact: study.contact },
      rater: { id: rater.id, deadline: rater.deadline },
      instrument,
      progress: progressOf(rater, step),
      step: stepView(rater, step),
    };
  };

  /** The rater's current step, which must be the one the request names and take answers. */
  const currentStepFor = (rater: RaterRow, key: string): Step => {
    const step = store.current(rater);
    if (stepKey(step) !== key) {
      throw new StepConflict(`this page is out of date: the current step is ${stepKey(step)}`);
    }
    if (step.kind === "waiting" || step.kind === "done" || step.kind === "declined") {
      throw new StepConflict("there is nothing to answer at this point");
    }
    return step;
  };

  const overview = (): AdminOverview => {
    const steps = store.steps();
    const assignments = store.assignments();
    const complete = (raterId: string, position: number) =>
      steps.some(
        (row) =>
          row.rater_id === raterId &&
          row.step === stepKey({ kind: "part", position, part: "D" }) &&
          row.submitted_at !== null,
      );
    return {
      study: { id: study.id, title: study.title, ratingsPerExercise: study.ratings_per_exercise },
      raters: store.raters().map((rater) => {
        const own = steps.filter((row) => row.rater_id === rater.id);
        const last = own
          .flatMap((row) => [row.opened_at, row.draft_saved_at, row.submitted_at])
          .filter((at): at is string => at !== null)
          .sort()
          .at(-1);
        const step = store.current(rater);
        const index = store
          .assignments(rater.id)
          .findIndex((row) => step.kind === "part" && row.position === step.position);
        return {
          id: rater.id,
          role: rater.role,
          status:
            rater.withdrawn_at !== null
              ? "Withdrawn"
              : step.kind === "part"
                ? `Exercise ${index + 1}, Part ${step.part}`
                : (
                    {
                      consent: own.length === 0 ? "Not started" : "Consent",
                      background: "Background",
                      onboarding: "Introduction",
                      calibration: "Practice",
                      calibration_review: "Practice",
                      waiting: "Waiting for assignment",
                      exit: "Final survey",
                      done: "Done",
                      declined: "Declined",
                    } as const
                  )[step.kind],
          lastActivity: last ?? null,
          deadline: rater.deadline,
          exercises: assignments
            .filter((row) => row.rater_id === rater.id)
            .map((row) => ({
              code: row.exercise,
              kind: row.kind,
              complete: complete(rater.id, row.position),
            })),
        };
      }),
      exercises: study.exercises.map((entry) => {
        // A main rater's planned rating, or a reserve rater's backup for one, counts toward the
        // planned ratings; a tie breaker's rating settles a disagreement and is kept apart.
        const readinessOf = (counts: (row: AssignmentRow) => boolean) =>
          assignments
            .filter(
              (row) =>
                row.exercise === entry.code && counts(row) && complete(row.rater_id, row.position),
            )
            .flatMap((row) => {
              const value = answersOf(
                row.rater_id,
                stepKey({ kind: "part", position: row.position, part: "D" }),
              ).RD2?.value;
              return typeof value === "number" ? [value] : [];
            });
        const readiness = readinessOf(
          (row) =>
            row.kind === "backup" ||
            (row.kind === "planned" && store.rater(row.rater_id)?.role === "main"),
        );
        const tieBreaker = readinessOf((row) => row.kind === "tie_breaker");
        const classes = new Set(readiness.map(readinessClass));
        return {
          code: entry.code,
          id: loaded.idOf.get(entry.code) ?? "",
          phase: entry.phase,
          planned: study.ratings_per_exercise,
          readiness,
          tieBreaker,
          agreement:
            readiness.length < study.ratings_per_exercise
              ? "pending"
              : classes.size === 1
                ? "agree"
                : tieBreaker.length > 0
                  ? "resolved"
                  : "differ",
        };
      }),
    };
  };

  const handle =
    (handler: (request: BunRequest) => Promise<Response> | Response) =>
    async (request: BunRequest): Promise<Response> => {
      try {
        return secured(await handler(request));
      } catch (error) {
        if (error instanceof HttpError) {
          return secured(json({ error: error.message }, error.status));
        }
        if (error instanceof StepConflict) {
          return secured(json({ error: error.message }, 409));
        }
        console.error(error);
        return secured(json({ error: "internal error" }, 500));
      }
    };

  const indexFile = Bun.file(join(web, "index.html"));
  const staticFile = async (request: BunRequest): Promise<Response> => {
    let path: string;
    try {
      path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^\/+/, "");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const file = path.startsWith("assets/") ? Bun.file(join(web, path)) : indexFile;
    if (!resolve(web, path).startsWith(web) || !(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file, {
      headers: {
        "Cache-Control": path.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  };

  return Bun.serve({
    port: options.port ?? 4180,
    hostname: options.hostname ?? "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    routes: {
      // For the container's health check: the server answers and its database can be read.
      "/healthz": handle(() => {
        store.raters();
        return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      }),
      "/r/:token": handle((request) => {
        const token = (request.params as { token: string }).token;
        const holder = store.holderOf(token);
        if (holder === null) {
          // The app explains how to get a valid link; a revoked one must not keep an old session.
          request.cookies.delete(COOKIE);
          return new Response(null, {
            status: 303,
            headers: { Location: "/", "Cache-Control": "no-store" },
          });
        }
        request.cookies.set(COOKIE, token, {
          httpOnly: true,
          sameSite: "strict",
          secure,
          path: "/",
        });
        // Leave the link out of the address bar and history once it has been exchanged.
        return new Response(null, {
          status: 303,
          headers: {
            Location: holder.kind === "admin" ? "/admin" : "/",
            "Cache-Control": "no-store",
          },
        });
      }),
      "/api/session": { GET: handle((request) => json(sessionOf(request))) },
      "/api/consent": {
        POST: handle(async (request) => {
          const rater = raterOf(request);
          const body = await readBody(request, consentRequestSchema);
          const step = currentStepFor(rater, "consent");
          const required = study.consent.statements.map((statement) => statement.id);
          if (body.accepted.length === 0) {
            store.decline(rater.id);
          } else if (required.every((id) => body.accepted.includes(id))) {
            store.submit(rater, step, { accepted: required }, instrument.version);
          } else {
            throw new HttpError(400, "every consent statement must be accepted to take part");
          }
          return json(sessionOf(request));
        }),
      },
      "/api/step/open": {
        POST: handle(async (request) => {
          const rater = raterOf(request);
          const { step } = await readBody(request, stepRequestSchema);
          currentStepFor(rater, step);
          store.open(rater.id, step);
          return json(sessionOf(request));
        }),
      },
      "/api/step/draft": {
        PUT: handle(async (request) => {
          const rater = raterOf(request);
          const body = await readBody(request, answersRequestSchema);
          currentStepFor(rater, body.step);
          return json({ savedAt: store.saveDraft(rater.id, body.step, body.answers) });
        }),
      },
      "/api/step/submit": {
        POST: handle(async (request) => {
          const rater = raterOf(request);
          const body = await readBody(request, answersRequestSchema);
          const step = currentStepFor(rater, body.step);
          if (step.kind === "consent") {
            throw new HttpError(400, "consent has its own endpoint");
          }
          const items = itemsOf(step);
          const issues = answerIssues(items, body.answers);
          if (issues.length > 0) {
            return json({ error: "some answers are missing", issues }, 422);
          }
          if (
            (step.kind === "part" || step.kind === "calibration") &&
            store.step(rater.id, body.step)?.opened_at == null
          ) {
            throw new HttpError(409, "this step's material was never opened");
          }
          store.submit(rater, step, normalizeAnswers(items, body.answers), instrument.version);
          return json(sessionOf(request));
        }),
      },
      "/api/events": {
        POST: handle(async (request) => {
          const rater = raterOf(request);
          const body = await readBody(request, eventsRequestSchema);
          currentStepFor(rater, body.step);
          store.logEvents(rater.id, body.step, body.events);
          return new Response(null, { status: 204 });
        }),
      },
      "/api/me/answers.csv": {
        GET: handle((request) => {
          const rater = raterOf(request);
          const rows = raterExport(loaded, store, rater.id).steps.flatMap((step) =>
            // Consent stores the accepted statements, not item answers.
            Object.entries(step.step === "consent" ? {} : step.answers).map(([item, answer]) => ({
              step: step.step,
              item,
              value: answer.values?.join(";") ?? answer.value,
              choice: answer.choice,
              text: answer.text,
            })),
          );
          return new Response(toCsv(["step", "item", "value", "choice", "text"], rows), {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${study.id}-${rater.id}.csv"`,
              "Cache-Control": "no-store",
            },
          });
        }),
      },
      "/api/me/answers.json": {
        GET: handle((request) => {
          const rater = raterOf(request);
          return new Response(JSON.stringify(raterExport(loaded, store, rater.id), null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="${study.id}-${rater.id}.json"`,
              "Cache-Control": "no-store",
            },
          });
        }),
      },
      "/api/admin/overview": {
        GET: handle((request) => {
          requireAdmin(request);
          return json(overview());
        }),
      },
      "/api/admin/assign": {
        POST: handle(async (request) => {
          requireAdmin(request);
          const body = await readBody(request, assignRequestSchema);
          const rater = store.rater(body.rater);
          if (rater?.role !== "reserve") {
            throw new HttpError(400, "only reserve raters receive exercises during the study");
          }
          const own = store.assignments(rater.id).map((row) => row.exercise);
          const unknown = body.exercises.filter(
            (code) => !study.exercises.some((entry) => entry.code === code),
          );
          if (unknown.length > 0 || body.exercises.some((code) => own.includes(code))) {
            throw new HttpError(400, "assign only study exercises the reserve rater has not rated");
          }
          if (own.length + body.exercises.length > 3) {
            throw new HttpError(400, "a reserve rater rates at most three exercises");
          }
          if (body.kind === "tie_breaker" && body.replaces !== null) {
            throw new HttpError(400, "a tie breaker replaces nobody");
          }
          if (body.kind === "backup") {
            const replaced = body.replaces === null ? null : store.rater(body.replaces);
            const planned =
              replaced === null
                ? []
                : store
                    .assignments(replaced.id)
                    .filter((row) => row.kind === "planned")
                    .map((row) => row.exercise);
            if (
              replaced?.role !== "main" ||
              body.exercises.some((code) => !planned.includes(code))
            ) {
              throw new HttpError(400, "a backup takes over exercises planned for a main rater");
            }
          }
          store.assign(rater.id, body.exercises, body.kind, body.replaces);
          return json(overview());
        }),
      },
      "/api/admin/deadline": {
        POST: handle(async (request) => {
          requireAdmin(request);
          const body = await readBody(request, deadlineRequestSchema);
          if (store.rater(body.rater) === null) {
            throw new HttpError(404, "unknown rater");
          }
          store.setDeadline(body.rater, body.deadline);
          return json(overview());
        }),
      },
      "/api/admin/link": {
        POST: handle(async (request) => {
          requireAdmin(request);
          const body = await readBody(request, linkRequestSchema);
          if (store.rater(body.rater) === null) {
            throw new HttpError(404, "unknown rater");
          }
          // The browser's origin, which readBody checked, is the public one even behind a proxy.
          const origin = request.headers.get("origin") ?? request.url;
          return json({ link: new URL(`/r/${store.issueLink(body.rater)}`, origin).href });
        }),
      },
      "/api/admin/export.zip": {
        GET: handle((request) => {
          requireAdmin(request);
          const roles = new URL(request.url).searchParams.getAll("role");
          return new Response(
            exportArchive(loaded, store, roles.length > 0 ? roles : ["main", "reserve"]),
            {
              headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${study.id}-export.zip"`,
                "Cache-Control": "no-store",
              },
            },
          );
        }),
      },
      "/api/*": handle(() => {
        throw new HttpError(404, "no such endpoint");
      }),
      "/*": handle(staticFile),
    },
  });
}
