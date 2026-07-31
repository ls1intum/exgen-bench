import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("a hard-killed Bun coordinator does not leave a command adapter running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exgen-orphan-"));
  const markerPath = join(directory, "child.pid");
  let childPid: number | undefined;
  const coordinator = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "fixtures", "orphan-parent.ts"), markerPath],
    { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore" },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(markerPath);
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    childPid = Number(await readFile(markerPath, "utf8"));
    coordinator.kill("SIGKILL");
    await coordinator.exited;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await Bun.sleep(10);
      } catch {
        childPid = undefined;
        break;
      }
    }
    expect(childPid).toBeUndefined();
  } finally {
    try {
      coordinator.kill("SIGKILL");
    } catch {}
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
