import type { ReferenceCost } from "../pricing/openrouter.ts";

export function referenceCostFields(referenceCost: ReferenceCost | undefined) {
  const empty = {
    reference_cost_amount: null,
    reference_cost_currency: null,
    reference_cost_model: null,
    reference_cost_model_source: null,
    reference_cost_retrieved_at: null,
    reference_cost_quote_sha256: null,
    reference_cost_prompt_rate: null,
    reference_cost_completion_rate: null,
    reference_cost_cache_read_rate: null,
    reference_cost_request_rate: null,
    reference_cost_assumptions: [],
    reference_cost_active_endpoint_count: null,
    reference_cost_priced_active_endpoint_count: null,
    reference_cost_active_endpoint_min: null,
    reference_cost_active_endpoint_max: null,
  };
  if (referenceCost?.status !== "estimated") {
    return {
      ...empty,
      reference_cost_status: referenceCost?.status ?? null,
      reference_cost_source: referenceCost?.source ?? null,
      reference_cost_unavailable_reason: referenceCost?.reason ?? null,
    };
  }
  return {
    reference_cost_status: referenceCost.status,
    reference_cost_amount: referenceCost.amount,
    reference_cost_currency: referenceCost.currency,
    reference_cost_source: referenceCost.source,
    reference_cost_model: referenceCost.model,
    reference_cost_model_source: referenceCost.model_source,
    reference_cost_retrieved_at: referenceCost.retrieved_at,
    reference_cost_quote_sha256: referenceCost.quote_sha256,
    reference_cost_prompt_rate: referenceCost.rates.prompt,
    reference_cost_completion_rate: referenceCost.rates.completion,
    reference_cost_cache_read_rate: referenceCost.rates.input_cache_read,
    reference_cost_request_rate: referenceCost.rates.request,
    reference_cost_assumptions: referenceCost.assumptions,
    reference_cost_active_endpoint_count: referenceCost.active_endpoint_count,
    reference_cost_priced_active_endpoint_count: referenceCost.priced_active_endpoint_count,
    reference_cost_active_endpoint_min: referenceCost.active_endpoint_amount_range?.minimum ?? null,
    reference_cost_active_endpoint_max: referenceCost.active_endpoint_amount_range?.maximum ?? null,
    reference_cost_unavailable_reason: null,
  };
}
