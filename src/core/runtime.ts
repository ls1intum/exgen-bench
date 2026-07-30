import type { System } from "../contracts.ts";

export interface RuntimeInvocation {
  argv: string[];
  cwd: string;
}

export interface RuntimeInvocationOptions {
  configDirectory: string;
  arguments: string[];
  mountDirectory?: string;
  containerWorkingDirectory?: string;
  includeDeclaredEnvironment: boolean;
}

export function resolveRuntimeCommand(command: string[]): string[] {
  return command.map((argument) => (argument === "{bun}" ? process.execPath : argument));
}

export function createRuntimeInvocation(
  system: System,
  options: RuntimeInvocationOptions,
): RuntimeInvocation {
  if (system.runtime.type === "command") {
    return {
      argv: [...resolveRuntimeCommand(system.runtime.command), ...options.arguments],
      cwd: options.configDirectory,
    };
  }

  const runtime = system.runtime;
  const argv = [
    runtime.engine,
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--network",
    runtime.network === "none" ? "none" : "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    runtime.pids_limit.toString(),
    "--memory",
    `${runtime.memory_mb}m`,
    "--cpus",
    runtime.cpus.toString(),
  ];
  if (runtime.read_only) {
    argv.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m");
  }
  if (runtime.user) {
    argv.push("--user", runtime.user);
  }
  if (options.mountDirectory) {
    argv.push(
      "--mount",
      `type=bind,src=${options.mountDirectory},dst=${options.containerWorkingDirectory ?? "/work"}`,
      "--workdir",
      options.containerWorkingDirectory ?? "/work",
    );
  }
  if (options.includeDeclaredEnvironment) {
    for (const name of Object.keys(runtime.env).sort()) {
      argv.push("--env", name);
    }
  }
  argv.push(runtime.image, ...runtime.command, ...options.arguments);
  return { argv, cwd: options.configDirectory };
}
