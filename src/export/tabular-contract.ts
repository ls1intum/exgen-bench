import type { AttemptAnalysisRow, ScoreAnalysisRow } from "./analysis.ts";

type CroissantType<Value> =
  NonNullable<Value> extends boolean
    ? "sc:Boolean"
    : NonNullable<Value> extends number
      ? "sc:Float" | "sc:Integer"
      : "sc:DateTime" | "sc:Text";

type TabularColumn<Row> = {
  [Name in keyof Row & string]: {
    name: Name;
    croissantType: CroissantType<Row[Name]>;
  };
}[keyof Row & string];

function defineColumns<Row>() {
  return <const Columns extends readonly TabularColumn<Row>[]>(
    columns: Columns &
      ([Exclude<keyof Row, Columns[number]["name"]>] extends [never]
        ? unknown
        : ["missing tabular columns", Exclude<keyof Row, Columns[number]["name"]>]),
  ): Columns => columns;
}

export const ATTEMPT_COLUMNS = defineColumns<AttemptAnalysisRow>()([
  { name: "attempt_id", croissantType: "sc:Text" },
  { name: "case_id", croissantType: "sc:Text" },
  { name: "system_id", croissantType: "sc:Text" },
  { name: "replicate", croissantType: "sc:Integer" },
  { name: "seed", croissantType: "sc:Integer" },
  { name: "generation_key", croissantType: "sc:Text" },
  { name: "generation_state", croissantType: "sc:Text" },
  { name: "generation_outcome", croissantType: "sc:Text" },
  { name: "generation_error", croissantType: "sc:Text" },
  { name: "generation_started_at", croissantType: "sc:DateTime" },
  { name: "generation_finished_at", croissantType: "sc:DateTime" },
  { name: "artifact_digest", croissantType: "sc:Text" },
  { name: "evidence_digest", croissantType: "sc:Text" },
  { name: "generation_budget_status", croissantType: "sc:Text" },
  { name: "budget_violations", croissantType: "sc:Text" },
  { name: "budget_missing", croissantType: "sc:Text" },
  { name: "generation_duration_ms", croissantType: "sc:Float" },
  { name: "model_calls", croissantType: "sc:Integer" },
  { name: "tool_calls", croissantType: "sc:Integer" },
  { name: "input_tokens", croissantType: "sc:Integer" },
  { name: "output_tokens", croissantType: "sc:Integer" },
  { name: "cached_input_tokens", croissantType: "sc:Integer" },
  { name: "reasoning_tokens", croissantType: "sc:Integer" },
  { name: "total_tokens", croissantType: "sc:Integer" },
  { name: "cost_amount", croissantType: "sc:Float" },
  { name: "cost_currency", croissantType: "sc:Text" },
  { name: "reference_cost_status", croissantType: "sc:Text" },
  { name: "reference_cost_amount", croissantType: "sc:Float" },
  { name: "reference_cost_currency", croissantType: "sc:Text" },
  { name: "reference_cost_source", croissantType: "sc:Text" },
  { name: "reference_cost_model", croissantType: "sc:Text" },
  { name: "reference_cost_model_source", croissantType: "sc:Text" },
  { name: "reference_cost_retrieved_at", croissantType: "sc:DateTime" },
  { name: "reference_cost_quote_sha256", croissantType: "sc:Text" },
  { name: "reference_cost_prompt_rate", croissantType: "sc:Text" },
  { name: "reference_cost_completion_rate", croissantType: "sc:Text" },
  { name: "reference_cost_cache_read_rate", croissantType: "sc:Text" },
  { name: "reference_cost_request_rate", croissantType: "sc:Text" },
  { name: "reference_cost_assumptions", croissantType: "sc:Text" },
  { name: "reference_cost_active_endpoint_count", croissantType: "sc:Integer" },
  { name: "reference_cost_priced_active_endpoint_count", croissantType: "sc:Integer" },
  { name: "reference_cost_active_endpoint_min", croissantType: "sc:Float" },
  { name: "reference_cost_active_endpoint_max", croissantType: "sc:Float" },
  { name: "reference_cost_unavailable_reason", croissantType: "sc:Text" },
  { name: "seed_status", croissantType: "sc:Text" },
  { name: "effective_parameters_digest", croissantType: "sc:Text" },
  { name: "provider_request_ids_digest", croissantType: "sc:Text" },
  { name: "provider_request_ids_complete", croissantType: "sc:Boolean" },
  { name: "evaluation_status", croissantType: "sc:Text" },
  { name: "evaluator_strict_success", croissantType: "sc:Boolean" },
  { name: "strict_success", croissantType: "sc:Boolean" },
  { name: "evaluation_failure", croissantType: "sc:Text" },
] as const);

export const SCORE_COLUMNS = defineColumns<ScoreAnalysisRow>()([
  { name: "attempt_id", croissantType: "sc:Text" },
  { name: "case_id", croissantType: "sc:Text" },
  { name: "system_id", croissantType: "sc:Text" },
  { name: "replicate", croissantType: "sc:Integer" },
  { name: "metric_id", croissantType: "sc:Text" },
  { name: "metric_version", croissantType: "sc:Text" },
  { name: "score_status", croissantType: "sc:Text" },
  { name: "value", croissantType: "sc:Text" },
  { name: "numerator", croissantType: "sc:Float" },
  { name: "denominator", croissantType: "sc:Float" },
] as const);
