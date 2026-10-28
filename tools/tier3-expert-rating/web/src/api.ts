import type { AdminOverview, LegalDocument, Session, Site, ViewEvent } from "../../shared/api.ts";
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
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, events }),
    }).catch(() => undefined);
  },
  admin: {
    overview: () => request<AdminOverview>("GET", "/api/admin/overview"),
    assign: (body: {
      rater: string;
      kind: "backup" | "tie_breaker";
      replaces: string | null;
      exercises: string[];
    }) => request<AdminOverview>("POST", "/api/admin/assign", body),
    deadline: (rater: string, deadline: string) =>
      request<AdminOverview>("POST", "/api/admin/deadline", { rater, deadline }),
    link: (rater: string) => request<{ link: string }>("POST", "/api/admin/link", { rater }),
  },
};
