import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { moment } from "../../dates.ts";
import type { Overview } from "./model.ts";
import { ROLE_LABEL } from "./model.ts";
import { Scrolling } from "./Scrolling.tsx";

/** Whether the parts take as long as the design budgets, and what raters say about the survey. */
export function Insights({ overview }: { overview: Overview }) {
  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-semibold">Time per part</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Median minutes from opening a part to submitting it, over every submitted part of every
          rater except the study team's tests, against the time the design budgets for it.
        </p>
        <Scrolling>
          <Table containerLabel="Time per part">
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead>Budget</TableHead>
                <TableHead>Median</TableHead>
                <TableHead>Against budget</TableHead>
                <TableHead>Parts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.timing.map((part) => (
                <TableRow key={part.part}>
                  <TableCell>
                    {part.part} · {part.title}
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">{part.budget} min</span>
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">
                      {part.median === null ? "—" : `${part.median} min`}
                    </span>
                  </TableCell>
                  <TableCell>
                    {part.median === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={
                          part.median > part.budget
                            ? "text-destructive tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {part.median > part.budget ? "+" : "−"}
                        {Math.abs(Math.round((part.median - part.budget) * 10) / 10)} min
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">{part.count}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Scrolling>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-semibold">Comments on the survey</h2>
        <p className="m-0 text-sm text-muted-foreground">
          The free text of the final survey, newest first.
        </p>
        {overview.feedback.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {overview.feedback.map((comment) => (
              <li
                key={`${comment.rater}-${comment.item}`}
                className="flex flex-col gap-1 border-l-2 pl-3"
              >
                <span className="text-xs text-muted-foreground">
                  {comment.rater} · {ROLE_LABEL[comment.role]} · {comment.item} ·{" "}
                  {moment(comment.at)}
                </span>
                <span className="text-sm font-medium">{comment.prompt}</span>
                <p className="m-0 text-sm whitespace-pre-wrap">{comment.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
