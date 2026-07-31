const argv = process.argv.slice(2);
if (argv.length === 0) {
  throw new Error("process supervisor requires a command");
}

const child = Bun.spawn(argv, {
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let killTimer: ReturnType<typeof setTimeout> | undefined;
const terminate = (): void => {
  if (killTimer !== undefined) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 500);
};
process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);

try {
  process.exitCode = await child.exited;
} finally {
  if (killTimer !== undefined) {
    clearTimeout(killTimer);
  }
  process.removeListener("SIGINT", terminate);
  process.removeListener("SIGTERM", terminate);
}
