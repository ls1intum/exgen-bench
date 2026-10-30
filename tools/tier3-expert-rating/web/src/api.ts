import type {
  AdminOverview,
  AssignmentKind,
  LegalDocument,
  Role,
  Session,
  Site,
  ViewEvent,
} from "../../shared/api.ts";
import { FINDINGS_PRESENTATION_VERSION } from "../../shared/findings-presentation.ts";
import type { AnswerIssue, SectionAnswers } from "../../shared/instrument.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: AnswerIssue[] = [],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Survey-Presentation": FINDINGS_PRESENTATION_VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as {
      error?: string;
      issues?: AnswerIssue[];
    };
    throw new ApiError(response.status, detail.error ?? response.statusText, detail.issues);
  }
  return (await response.json()) as T;
}

export const api = {
  site: () => request<Site>("GET", "/api/site"),
  legal: (id: string) => request<LegalDocument>("GET", `/api/legal/${encodeURIComponent(id)}`),
  session: () => request<Session>("GET", "/api/session"),
  consent: (accepted: string[]) => request<Session>("POST", "/api/consent", { accepted }),
  open: (step: string) => request<Session>("POST", "/api/step/open", { step }),
  draft: (step: string, answers: SectionAnswers) =>
    request<{ savedAt: string }>("PUT", "/api/step/draft", { step, answers }),
  submit: (step: string, answers: SectionAnswers) =>
    request<Session>("POST", "/api/step/submit", { step, answers }),
  /** Which views a rater opened; best effort, so a lost event never interrupts the rating. */
  events: (step: string, events: ViewEvent[]) => {
    void fetch("/api/events", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Survey-Presentation": FINDINGS_PRESENTATION_VERSION,
      },
      body: JSON.stringify({ step, events }),
    }).catch(() => undefined);
  },
  admin: {
    overview: () => request<AdminOverview>("GET", "/api/admin/overview"),
    addRater: (body: { id: string; role: Role; deadline: string | null; exercises: string[] }) =>
      request<{ overview: AdminOverview; link: string }>("POST", "/api/admin/raters", body),
    assign: (body: {
      rater: string;
      kind: Exclude<AssignmentKind, "planned">;
      replaces: string | null;
      exercises: string[];
    }) => request<AdminOverview>("POST", "/api/admin/assign", body),
    unassign: (rater: string, exercise: string) =>
      request<AdminOverview>("POST", "/api/admin/unassign", { rater, exercise }),
    deadline: (rater: string, deadline: string) =>
      request<AdminOverview>("POST", "/api/admin/deadline", { rater, deadline }),
    link: (rater: string) => request<{ link: string }>("POST", "/api/admin/link", { rater }),
    revoke: (rater: string) => request<AdminOverview>("POST", "/api/admin/revoke", { rater }),
    withdraw: (rater: string) => request<AdminOverview>("POST", "/api/admin/withdraw", { rater }),
  },
};
