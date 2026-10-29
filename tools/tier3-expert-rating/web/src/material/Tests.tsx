import { CircleDotIcon, CircleXIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent } from "@/components/ui/item";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { Inline } from "../items/ItemField.tsx";

type Groups = NonNullable<ExerciseView["tests"]>;
type Test = Groups[number]["tests"][number];

const SHORT = 160;

/** A failure message as students see it: the first line, the rest on request. */
function Message({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text === "") {
    return <p className="m-0 text-xs text-muted-foreground italic">No message</p>;
  }
  const firstLine = text.split("\n")[0] ?? "";
  const long = text.includes("\n") || text.length > SHORT;
  const shown = expanded || !long ? text : firstLine.slice(0, SHORT);
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="m-0 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
        {shown}
        {!expanded && long && "…"}
      </p>
      {long && (
        <Button variant="link" size="xs" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show the whole message"}
        </Button>
      )}
    </div>
  );
}

function TestRow({ test, message }: { test: Test; message: boolean }) {
  return (
    <Item size="sm">
      <ItemContent>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <CircleXIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          <span className="font-mono text-xs break-all">{test.name}</span>
          <span className="sr-only">fails</span>
        </div>
        {test.variant !== undefined && (
          <p className="m-0 text-xs text-muted-foreground">
            With a wrong variant of the sample solution, it fails with:
          </p>
        )}
        {message && <Message text={test.message} />}
        {test.variant !== undefined && (
          <p className="m-0 text-xs break-words text-muted-foreground">
            <span className="font-medium">The variant:</span> <Inline>{test.variant}</Inline>
          </p>
        )}
      </ItemContent>
    </Item>
  );
}

function TaskTests({ task, tests }: { task: string | null; tests: Test[] }) {
  // On the template, stubs often fail every test of a task the same way; say it once.
  const shared =
    tests.length > 1 &&
    tests.every((test) => test.message === tests[0]?.message && test.variant === undefined)
      ? tests[0]?.message
      : undefined;
  return (
    <section aria-label={task ?? "Tests not linked to a task"} className="flex flex-col gap-2">
      <h3 className="m-0 flex items-start gap-2 text-sm font-semibold">
        {task !== null && (
          <CircleDotIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        )}
        <span>
          {task ?? "Not linked to a task"}{" "}
          <span className="font-normal whitespace-nowrap text-muted-foreground">
            {tests.length} {tests.length === 1 ? "test" : "tests"}
          </span>
        </span>
      </h3>
      {task === null && (
        <p className="m-0 text-sm text-muted-foreground">
          These tests count towards the score, but no task in the problem statement names them.
        </p>
      )}
      {shared !== undefined && (
        <div className="flex flex-col gap-1 rounded-lg bg-muted/60 px-3 py-2">
          <p className="m-0 text-xs font-medium">
            All {tests.length} tests fail on the template with the same message:
          </p>
          <Message text={shared} />
        </div>
      )}
      <ul className="m-0 list-none divide-y rounded-lg border p-0">
        {tests.map((test) => (
          <li key={test.name}>
            <TestRow test={test} message={shared === undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The test overview as students see it in Artemis: names and failure messages, not test code. */
export function Tests({ groups }: { groups: Groups }) {
  if (groups.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No tests</EmptyTitle>
          <EmptyDescription>The exercise has no tests that run on the template.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-sm text-muted-foreground">
        Unless a wrong variant is named, a message is the one the test reports on the template.
      </p>
      {groups.map((group) => (
        <TaskTests key={group.task ?? ""} task={group.task} tests={group.tests} />
      ))}
    </div>
  );
}
