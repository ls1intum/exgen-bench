const REQUIRED_BUN_VERSION = "1.3.14";

export function requireSupportedToolchain(): void {
  if (Bun.version !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `exgen-bench requires Bun ${REQUIRED_BUN_VERSION}; current runtime is ${Bun.version}. ` +
        "Install the version declared in .bun-version before running project commands.",
    );
  }
}
