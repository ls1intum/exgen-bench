import type { System } from "../contracts.ts";

export interface RuntimeInvocation {
  argv: string[];
  cwd: string;
}

export interface RuntimeMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface RuntimeInvocationOptions {
  configDirectory: string;
  arguments: string[];
  mounts?: RuntimeMount[];
  containerWorkingDirectory?: string;
  containerName?: string;
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
    runtime.network,
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
  argv.push("--user", runtime.user);
  if (options.containerName) {
    argv.push("--name", options.containerName);
  }
  for (const mount of options.mounts ?? []) {
    argv.push(
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    );
  }
  if (options.containerWorkingDirectory) {
    argv.push("--workdir", options.containerWorkingDirectory);
  }
  if (options.includeDeclaredEnvironment) {
    for (const name of Object.keys(runtime.env).sort()) {
      argv.push("--env", name);
    }
  }
  argv.push(runtime.image, ...runtime.command, ...options.arguments);
  return { argv, cwd: options.configDirectory };
}
