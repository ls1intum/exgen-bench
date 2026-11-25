import { digestJson } from "../../../../src/core/canonical.ts";
import type { Exercise } from "../../../tier3-expert-rating/shared/exercise.ts";
import type {
  Answer,
  Instrument,
  PartId,
  SectionAnswers,
} from "../../../tier3-expert-rating/shared/instrument.ts";
import { type CallPlan, callPlan, STAGED_JUDGE_VERSION } from "./contract.ts";
import { type StageMaterial, stageMaterial } from "./material.ts";
import {
  type ChatMessage,
  type PriorAnswer,
  rubricSha256,
  setupFilesMessage,
  systemMessage,
  userMessage,
} from "./prompt.ts";
import { parseReply, validateAnswers } from "./response.ts";
import {
  type Completion,
  type Transport,
  type TransportDescription,
  TransportError,
} from "./transport.ts";

/**
 * Run the staged judge on one exercise: five calls, each a fresh conversation, in the survey's
 * order. A call sees only its part's material; only D-FIND sees earlier answers, and only the
 * judge's own RD1, RD2 and GRADE. Every call is recorded with its exact messages, replies and digests.
 */

export type CallStatus = "answered" | "invalid_output" | "model_error" | "unavailable";
export type ItemStatus = CallStatus | "not_answered";

export interface Attempt {
  turn: number;
  outcome: "completion" | "error";
  error?: string;
  http_status?: number;
  retryable?: boolean;
  content?: string | null;
  finish_reason?: string;
  provider_request_id?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface CallRecord {
  call: string;
  part: PartId;
  items: string[];
  status: CallStatus;
  issues: string[];
  materials: string[];
  presentation: StageMaterial["presentation"];
  evidence_sha256: string;
  /** Digest of the earlier own answers this call showed, null when it showed none. */
  prior_answers_sha256: string | null;
  /** Digest of the opening system and user messages. */
  prompt_sha256: string;
  setup_catalog: string[];
  setup_files_read: string[];
  omitted_binary: string[];
  /** The whole conversation: what was sent, and every reply. */
  messages: ChatMessage[];
  attempts: Attempt[];
  answers: SectionAnswers | null;
  evidence_refs: Record<string, string[]>;
  evidence_issues: Record<string, string[]>;
  rationale: Record<string, string>;
  /** The reply's answers when they failed validation, kept for diagnosis and never scored. */
  rejected_answers?: unknown;
}

export interface ItemRow {
  judge_version: string;
  rubric_version: string;
  exercise_id: string;
  part: PartId;
  call: string;
  item_id: string;
  status: ItemStatus;
  answer: Answer | null;
  evidence_refs: string[];
  evidence_issues: string[];
  rationale: string | null;
  evidence_sha256: string;
  prior_answers_sha256: string | null;
  models: string[];
}

export interface ExerciseJudgement {
  judge_version: string;
  rubric_version: string;
  rubric_sha256: string;
  exercise_id: string;
  exercise_sha256: string;
  transport: TransportDescription;
  started_at: string;
  finished_at: string;
  calls: CallRecord[];
  rows: ItemRow[];
}

export interface RunOptions {
  maxAttempts: number;
  setupReads: { enabled: boolean; maxFiles: number };
  retryDelayMs?: number;
  now?: () => Date;
}

type CallOutcome =
  { kind: "completion"; completion: Completion } | { kind: "error"; message: string };

async function completeWithRetries(
  transport: Transport,
  messages: ChatMessage[],
  turn: number,
  attempts: Attempt[],
  options: RunOptions,
): Promise<CallOutcome> {
  let last = "no attempt was made";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const completion = await transport.complete(messages);
      attempts.push({
        turn,
        outcome: "completion",
        content: completion.content,
        ...(completion.finishReason === undefined
          ? {}
          : { finish_reason: completion.finishReason }),
        ...(completion.providerRequestId === undefined
          ? {}
          : { provider_request_id: completion.providerRequestId }),
        ...(completion.model === undefined ? {} : { model: completion.model }),
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      });
      return { kind: "completion", completion };
    } catch (error) {
      const retryable = error instanceof TransportError ? error.retryable : false;
      last = error instanceof Error ? error.message : String(error);
      attempts.push({
        turn,
        outcome: "error",
        error: last,
        retryable,
        ...(error instanceof TransportError && error.status !== undefined
          ? { http_status: error.status }
          : {}),
      });
      if (!retryable) break;
      if (attempt < options.maxAttempts && (options.retryDelayMs ?? 0) > 0) {
        await Bun.sleep((options.retryDelayMs ?? 0) * attempt);
      }
    }
  }
  return { kind: "error", message: last };
}

function priorAnswers(plan: CallPlan, instrument: Instrument, records: CallRecord[]) {
  const prior: PriorAnswer[] = [];
  const missing: string[] = [];
  for (const id of plan.prior) {
    const record = records.find((candidate) => candidate.items.includes(id));
    const answer = record?.status === "answered" ? record.answers?.[id] : undefined;
    const item = instrument.questionnaire.parts
      .flatMap((part) => part.items)
      .find((candidate) => candidate.id === id);
    if (record === undefined || answer === undefined || item === undefined) {
      missing.push(id);
      continue;
    }
    // Give the model the same record the instructor can reopen: the choice and repair note.
    prior.push({ item, part: record.part, answer });
  }
  return { prior, missing };
}

async function runCall(
  plan: CallPlan,
  exercise: Exercise,
  instrument: Instrument,
  material: StageMaterial,
  records: CallRecord[],
  transport: Transport,
  options: RunOptions,
): Promise<CallRecord> {
  const part = instrument.questionnaire.parts.find((candidate) => candidate.id === plan.part);
  if (part === undefined) throw new Error(`no part ${plan.part}`);
  const { prior, missing } = priorAnswers(plan, instrument, records);
  const record: CallRecord = {
    call: plan.id,
    part: plan.part,
    items: plan.items.map((item) => item.id),
    status: "unavailable",
    issues: [],
    materials: material.materials,
    presentation: material.presentation,
    evidence_sha256: material.evidenceSha256,
    prior_answers_sha256:
      plan.prior.length === 0
        ? null
        : digestJson(
            prior.map((entry) => ({
              item: entry.item.id,
              answer: entry.answer,
            })),
          ),
    prompt_sha256: "",
    setup_catalog: material.setup.map((file) => file.path),
    setup_files_read: [],
    omitted_binary: material.omitted,
    messages: [],
    attempts: [],
    answers: null,
    evidence_refs: {},
    evidence_issues: {},
    rationale: {},
  };
  if (missing.length > 0) {
    record.issues.push(
      `the judge's own earlier answer to ${missing.join(" and ")} is not available`,
    );
    return record;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemMessage(instrument) },
    {
      role: "user",
      content: userMessage({
        instrument,
        part,
        phase: exercise.phase,
        plan,
        material,
        prior,
        setupReads: options.setupReads,
      }),
    },
  ];
  record.prompt_sha256 = digestJson(messages);
  record.messages = messages;
  let readsLeft = options.setupReads.enabled && material.setup.length > 0 ? 1 : 0;
  for (let turn = 1; ; turn += 1) {
    const outcome = await completeWithRetries(transport, messages, turn, record.attempts, options);
    if (outcome.kind === "error") {
      record.status = "model_error";
      record.issues.push(outcome.message);
      return record;
    }
    const { content, finishReason } = outcome.completion;
    if (content === null || content.trim() === "") {
      record.status = "model_error";
      record.issues.push("the model returned no content");
      return record;
    }
    messages.push({ role: "assistant", content });
    if (finishReason === "length") {
      record.status = "model_error";
      record.issues.push("the reply was cut off at the output token limit");
      return record;
    }
    const reply = parseReply(content);
    if (reply.kind === "invalid") {
      record.status = "invalid_output";
      record.issues.push(...reply.issues);
      return record;
    }
    if (reply.kind === "read") {
      const available = new Map(material.setup.map((file) => [file.path, file]));
      const problems: string[] = [];
      if (readsLeft === 0) problems.push("asked for setup files when no request was offered");
      if (reply.paths.length > options.setupReads.maxFiles) {
        problems.push(
          `asked for ${reply.paths.length} files, at most ${options.setupReads.maxFiles}`,
        );
      }
      if (new Set(reply.paths).size !== reply.paths.length) problems.push("asked for a file twice");
      for (const path of reply.paths) {
        if (!available.has(path))
          problems.push(`${path} is not a build or setup file of this stage`);
      }
      if (problems.length > 0) {
        record.status = "invalid_output";
        record.issues.push(...problems);
        return record;
      }
      readsLeft -= 1;
      record.setup_files_read.push(...reply.paths);
      messages.push({
        role: "user",
        content: setupFilesMessage(
          material.setup.filter((file) => reply.paths.includes(file.path)),
        ),
      });
      continue;
    }
    const unopened = new Set(
      material.setup
        .filter((file) => !record.setup_files_read.includes(file.path))
        .map((file) => `file:${file.path}`),
    );
    const validated = validateAnswers(plan.items, reply.answers, {
      names: new Set([...material.locators.names].filter((name) => !unopened.has(name))),
      lines: new Map([...material.locators.lines].filter(([name]) => !unopened.has(name))),
    });
    record.evidence_refs = validated.evidenceRefs;
    record.evidence_issues = validated.evidenceIssues;
    record.rationale = validated.rationale;
    if (validated.issues.length > 0) {
      record.status = "invalid_output";
      record.issues.push(...validated.issues);
      record.rejected_answers = reply.answers;
      return record;
    }
    record.status = "answered";
    record.answers = validated.answers;
    return record;
  }
}

function rows(judgement: Omit<ExerciseJudgement, "rows">): ItemRow[] {
  return judgement.calls.flatMap((call) => {
    const models = [
      ...new Set(call.attempts.flatMap((attempt) => (attempt.model ? [attempt.model] : []))),
    ];
    return call.items.map((id): ItemRow => {
      const answer = call.status === "answered" ? (call.answers?.[id] ?? null) : null;
      return {
        judge_version: judgement.judge_version,
        rubric_version: judgement.rubric_version,
        exercise_id: judgement.exercise_id,
        part: call.part,
        call: call.call,
        item_id: id,
        status: call.status === "answered" && answer === null ? "not_answered" : call.status,
        answer,
        evidence_refs: call.status === "answered" ? (call.evidence_refs[id] ?? []) : [],
        evidence_issues: call.evidence_issues[id] ?? [],
        rationale: call.status === "answered" ? (call.rationale[id] ?? null) : null,
        evidence_sha256: call.evidence_sha256,
        prior_answers_sha256: call.prior_answers_sha256,
        models,
      };
    });
  });
}

export async function judgeExercise(
  exercise: Exercise,
  instrument: Instrument,
  transport: Transport,
  options: RunOptions,
): Promise<ExerciseJudgement> {
  const now = options.now ?? (() => new Date());
  const started = now().toISOString();
  const plans = callPlan(instrument);
  const materials = new Map<PartId, StageMaterial>();
  const records: CallRecord[] = [];
  for (const plan of plans) {
    let material = materials.get(plan.part);
    if (material === undefined) {
      material = stageMaterial(exercise, instrument, plan.part);
      materials.set(plan.part, material);
    }
    records.push(await runCall(plan, exercise, instrument, material, records, transport, options));
  }
  const judgement = {
    judge_version: STAGED_JUDGE_VERSION,
    rubric_version: instrument.version,
    rubric_sha256: rubricSha256(instrument),
    exercise_id: exercise.id,
    exercise_sha256: digestJson(exercise),
    transport: transport.describe(),
    started_at: started,
    finished_at: now().toISOString(),
    calls: records,
  };
  return { ...judgement, rows: rows(judgement) };
}
