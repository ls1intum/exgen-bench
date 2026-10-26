import { CircleXIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { ExerciseView } from "../../../shared/exercise.ts";

type Groups = NonNullable<ExerciseView["tests"]>;

/** The test overview as students see it in Artemis: names and failure messages, not test code. */
export function Tests({ groups }: { groups: Groups }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-sm text-muted-foreground">
        Each test fails on the template. The message below a test is what a student sees until their
        solution passes it.
      </p>
      {groups.map((group) => (
        <section key={group.task ?? ""} aria-label={group.task ?? "Tests not linked to a task"}>
          <h3 className="mt-0 mb-2 text-sm font-semibold">
            {group.task === null ? "Tests not linked to a task" : `Task: ${group.task}`}
          </h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {group.tests.map((test) => (
              <li key={test.name} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CircleXIcon aria-hidden="true" className="size-4 text-destructive" />
                  <span className="font-mono text-xs font-medium">{test.name}</span>
                  {test.generic && <Badge variant="outline">No message of its own</Badge>}
                </div>
                <p className="mt-2 mb-0 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                  {test.message === "" ? "(no message)" : test.message}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
