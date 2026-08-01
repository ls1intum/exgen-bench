import type { FactorScalar } from "../../src/contracts.ts";

// Artemis attests the resolved effort profile, but not its per-request token or duration bounds.
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

/** Encodes milliseconds for Artemis's ISO-8601 duration field without losing precision. */
export function isoDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return `PT${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, "")}S`;
}

/** Maps attested factors to Artemis controls and rejects unsupported contrasts. */
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
  return effortProfile === undefined ? {} : { [OBSERVED_FACTORS[0]]: effortProfile };
}
