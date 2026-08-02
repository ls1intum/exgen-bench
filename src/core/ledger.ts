import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExperimentPlan, PlannedAttempt } from "./plan.ts";

export type AttemptState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AttemptRow extends PlannedAttempt {
  state: AttemptState;
  outcome: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  artifactDigest: string | null;
  evidenceDigest: string | null;
}

interface AttemptDatabaseRow {
  ordinal: number;
  id: string;
  generation_key: string;
  case_id: string;
  system_id: string;
  replicate: number;
  seed: number;
  state: AttemptState;
  outcome: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  artifact_digest: string | null;
  evidence_digest: string | null;
}

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

function changedRows(database: Database): number {
  return database.query<{ count: number }, []>("SELECT changes() AS count").get()?.count ?? 0;
}

function fromDatabase(row: AttemptDatabaseRow): AttemptRow {
  return {
    ordinal: row.ordinal,
    id: row.id,
    generationKey: row.generation_key,
    caseId: row.case_id,
    systemId: row.system_id,
    replicate: row.replicate,
    seed: row.seed,
    state: row.state,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    artifactDigest: row.artifact_digest,
    evidenceDigest: row.evidence_digest,
  };
}

export class Ledger {
  readonly #database: Database;

  private constructor(database: Database) {
    this.#database = database;
  }

  static async create(runDirectory: string, plan: ExperimentPlan): Promise<Ledger> {
    await mkdir(runDirectory, { recursive: true });
    const database = new Database(join(runDirectory, "ledger.sqlite"), {
      create: true,
      strict: true,
    });
    // busy_timeout must precede journal_mode = WAL: that pragma takes a brief exclusive lock and
    // returns SQLITE_BUSY immediately unless a timeout is already in effect.
    database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS attempts (
        ordinal INTEGER NOT NULL UNIQUE,
        id TEXT PRIMARY KEY,
        generation_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        system_id TEXT NOT NULL,
        replicate INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('planned', 'running', 'completed', 'failed', 'cancelled', 'interrupted')
        ),
        outcome TEXT,
        started_at TEXT,
        finished_at TEXT,
        error_code TEXT,
        artifact_digest TEXT,
        evidence_digest TEXT
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        attempt_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT
    `);

    const insertMetadata = database.prepare(
      "INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)",
    );
    insertMetadata.run("schema_version", "1");
    insertMetadata.run("plan_id", plan.id);

    const recordedPlanId = database
      .query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'plan_id'")
      .get()?.value;
    if (recordedPlanId !== plan.id) {
      database.close();
      throw new Error(`run ledger belongs to plan ${recordedPlanId ?? "unknown"}, not ${plan.id}`);
    }

    const insertAttempt = database.prepare(`
      INSERT OR IGNORE INTO attempts (
        ordinal, id, generation_key, case_id, system_id, replicate, seed, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')
    `);
    const insertAll = database.transaction((attempts: PlannedAttempt[]) => {
      for (const attempt of attempts) {
        insertAttempt.run(
          attempt.ordinal,
          attempt.id,
          attempt.generationKey,
          attempt.caseId,
          attempt.systemId,
          attempt.replicate,
          attempt.seed,
        );
      }
    });
    insertAll(plan.attempts);

    return new Ledger(database);
  }

  static open(runDirectory: string): Ledger {
    const database = new Database(join(runDirectory, "ledger.sqlite"), {
      create: false,
      readwrite: true,
      strict: true,
    });
    database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.run("PRAGMA foreign_keys = ON");
    return new Ledger(database);
  }

  planId(): string {
    const planId = this.#database
      .query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'plan_id'")
      .get()?.value;
    if (!planId) {
      throw new Error("run ledger does not contain a plan ID");
    }
    return planId;
  }

  close(): void {
    this.#database.close();
  }

  list(states?: AttemptState[]): AttemptRow[] {
    const rows =
      states && states.length > 0
        ? this.#database
            .query<AttemptDatabaseRow, AttemptState[]>(
              `SELECT * FROM attempts WHERE state IN (${states.map(() => "?").join(",")})
               ORDER BY ordinal`,
            )
            .all(...states)
        : this.#database
            .query<AttemptDatabaseRow, []>("SELECT * FROM attempts ORDER BY ordinal")
            .all();
    return rows.map(fromDatabase);
  }

  claim(attemptId: string, occurredAt: string): boolean {
    const claimTransaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          `UPDATE attempts
           SET state = 'running', started_at = ?, finished_at = NULL, error_code = NULL
           WHERE id = ? AND state = 'planned'`,
        )
        .run(occurredAt, attemptId);
      const changed = changedRows(this.#database);
      if (changed === 1) {
        this.appendEvent(attemptId, "attempt.started", {}, occurredAt);
      }
      return changed === 1;
    });
    return claimTransaction();
  }

  finish(
    attemptId: string,
    state: Exclude<AttemptState, "planned" | "running">,
    details: {
      occurredAt: string;
      outcome?: string;
      errorCode?: string;
      artifactDigest?: string;
      evidenceDigest?: string;
    },
  ): void {
    const finishTransaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          `UPDATE attempts
           SET state = ?, outcome = ?, finished_at = ?, error_code = ?, artifact_digest = ?,
               evidence_digest = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(
          state,
          details.outcome ?? null,
          details.occurredAt,
          details.errorCode ?? null,
          details.artifactDigest ?? null,
          details.evidenceDigest ?? null,
          attemptId,
        );
      const changed = changedRows(this.#database);
      if (changed !== 1) {
        throw new Error(`attempt ${attemptId} is not running`);
      }
      this.appendEvent(
        attemptId,
        `attempt.${state}`,
        {
          outcome: details.outcome,
          error_code: details.errorCode,
          artifact_digest: details.artifactDigest,
          evidence_digest: details.evidenceDigest,
        },
        details.occurredAt,
      );
    });
    finishTransaction();
  }

  appendEvent(
    attemptId: string | null,
    type: string,
    payload: unknown,
    occurredAt = new Date().toISOString(),
  ): void {
    this.#database
      .prepare(
        "INSERT INTO events (occurred_at, attempt_id, type, payload_json) VALUES (?, ?, ?, ?)",
      )
      .run(occurredAt, attemptId, type, JSON.stringify(payload));
  }
}
