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
import { Scrolling } from "./Scrolling.tsx";

/** Every change the study team made, newest first; the export holds the same list. */
export function Changes({ overview }: { overview: Overview }) {
  if (overview.changes.length === 0) {
    return <p className="m-0 text-sm text-muted-foreground">Nothing has been changed yet.</p>;
  }
  return (
    <Scrolling>
      <Table containerLabel="Changes">
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Change</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.changes.map((change) => (
            <TableRow key={`${change.at}-${change.action}-${change.detail}`}>
              <TableCell>
                <span className="whitespace-nowrap">{moment(change.at)}</span>
              </TableCell>
              <TableCell>
                <span className="whitespace-nowrap">
                  {change.action.charAt(0).toUpperCase() + change.action.slice(1)}
                </span>
              </TableCell>
              <TableCell>{change.detail}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scrolling>
  );
}
