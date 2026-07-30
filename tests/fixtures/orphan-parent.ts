import { supervisedCommand, supervisedEnvironment } from "../../src/core/process-supervision.ts";

const markerPath = process.argv[2];
if (!markerPath) {
  throw new Error("missing marker path");
}

Bun.spawn(
  supervisedCommand([
    "/bin/sh",
    "-c",
    "echo $$ > \"$1\"; trap '' TERM; while :; do sleep 1; done",
    "_",
    markerPath,
  ]),
  {
    env: supervisedEnvironment(process.env),
    stdout: "ignore",
    stderr: "ignore",
  },
);
await new Promise(() => undefined);
