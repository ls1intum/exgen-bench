import type { FactorScalar } from "../../src/contracts.ts";

/**
 * What one generation run may be told to do differently, and what Artemis attests afterwards.
 *
 * Artemis accepts three narrowing controls on a start request: a profile *name* drawn from the
 * admin-defined set, and two numeric bounds that may only tighten that profile. It echoes back
 * exactly one of them — the resolved profile name — on the terminal status, so that a caller can
 * verify what ran rather than what it asked for.
 *
 * That asymmetry decides what may be a factor. A contrast has to rest on something the system under
 * test attests, so `effort_profile` is a factor and the two bounds are not: a study that varied them
 * would be comparing two arms on the adapter's word alone. They stay reachable as parameters.
 */
export const CONTROLLED_FACTORS = ["effort_profile"] as const;

export const OBSERVED_FACTORS = ["effort_profile"] as const;

const EFFORT_PROFILE = CONTROLLED_FACTORS[0];

const TIGHTENING_PARAMETERS = ["max_tokens", "max_job_duration_ms"] as const;

export interface GenerationControls {
  effortProfile?: string;
  maxTokens?: number;
  maxJobDurationMs?: number;
}

export class ArtemisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtemisConfigurationError";
  }
}

/**
 * Artemis binds `maxJobDuration` as a `java.time.Duration`, whose Jackson deserializer reads an
 * ISO-8601 string. Seconds keep the encoding exact for any millisecond value.
 */
export function isoDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return `PT${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, "")}S`;
}

/**
 * Maps the requested factors of one attempt onto Artemis's start controls. A requested factor this
 * adapter cannot apply is rejected rather than ignored: silently dropping one is how two arms of a
 * comparison both run the deployment default and look like a result.
 */
export function resolveRequestedFactors(
  factors: Record<string, FactorScalar>,
  defaults: GenerationControls,
): GenerationControls {
  const controls: GenerationControls = { ...defaults };
  for (const [name, value] of Object.entries(factors)) {
    if ((TIGHTENING_PARAMETERS as readonly string[]).includes(name)) {
      throw new ArtemisConfigurationError(
        `factor ${name} cannot ground a contrast: Artemis applies it but never attests it, so set it under parameters.generation.${name} instead`,
      );
    }
    if (!(CONTROLLED_FACTORS as readonly string[]).includes(name)) {
      throw new ArtemisConfigurationError(
        `requested factor ${name} is not one this adapter can apply (it controls ${CONTROLLED_FACTORS.join(", ")})`,
      );
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 64) {
      throw new ArtemisConfigurationError(
        `factor ${EFFORT_PROFILE} must be a non-empty Artemis profile name of at most 64 characters, received ${JSON.stringify(value)}`,
      );
    }
    controls.effortProfile = value;
  }
  return controls;
}

export function startControls(controls: GenerationControls): Record<string, unknown> {
  return {
    ...(controls.effortProfile === undefined ? {} : { effortProfile: controls.effortProfile }),
    ...(controls.maxTokens === undefined ? {} : { maxTokens: controls.maxTokens }),
    ...(controls.maxJobDurationMs === undefined
      ? {}
      : { maxJobDuration: isoDuration(controls.maxJobDurationMs) }),
  };
}

export function observedFactors(effortProfile: string | undefined): Record<string, FactorScalar> {
  // Keyed off the same constant the capability declares and the request-time check enforces: the
  // spelling has to be identical across the configuration, the request, this echo and `observes`,
  // and four literals would let them drift.
  return effortProfile === undefined ? {} : { [OBSERVED_FACTORS[0]]: effortProfile };
}
