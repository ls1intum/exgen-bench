import { join } from "node:path";

export function supervisedCommand(argv: readonly string[]): string[] {
  return [process.execPath, "run", join(import.meta.dir, "process-supervisor.ts"), ...argv];
}

export function supervisedEnvironment<Environment extends Record<string, string | undefined>>(
  environment: Environment,
): Environment & { BUN_FEATURE_FLAG_NO_ORPHANS: "1" } {
  return { ...environment, BUN_FEATURE_FLAG_NO_ORPHANS: "1" };
}
