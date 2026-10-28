import type { AdminOverview, AssignmentKind, Role } from "../../../../shared/api.ts";
import { daysSince, today } from "../../dates.ts";

export type Overview = AdminOverview;
export type Rater = AdminOverview["raters"][number];
export type Exercise = AdminOverview["exercises"][number];

/** A rater who started but has not been active for this many days needs a reminder. */
export const INACTIVE_DAYS = 3;

export const ROLE_LABEL: Record<Role, string> = {
  main: "Main",
  reserve: "Reserve",
  pilot: "Pilot",
  test: "Test",
};

/** The letter IDs of each role start with, so a new rater's ID can be suggested. */
const ROLE_PREFIX: Record<Role, string> = { main: "R", reserve: "R", pilot: "P", test: "T" };

export const KIND_LABEL: Record<AssignmentKind, string> = {
  planned: "Planned",
  additional: "Additional",
  backup: "Backup",
  tie_breaker: "Tie breaker",
};

/** Whether a rater is still taking part: not done, declined or withdrawn. */
export function active(rater: Rater): boolean {
  return !rater.withdrawn && rater.status !== "Done" && rater.status !== "Declined";
}

export function overdue(rater: Rater, now = Date.now()): boolean {
  return active(rater) && rater.deadline !== null && rater.deadline < today(now);
}

/** Days without activity of a rater who has started and not finished; null when that is not the case. */
export function inactiveDays(rater: Rater, now = Date.now()): number | null {
  if (!active(rater) || rater.lastActivity === null) return null;
  const days = daysSince(rater.lastActivity, now);
  return days >= INACTIVE_DAYS ? days : null;
}

/** The next free ID for a role, such as P7 after P1 to P6. */
export function nextId(overview: Overview, role: Role): string {
  const prefix = ROLE_PREFIX[role];
  const taken = new Set(overview.raters.map((rater) => rater.id));
  let number = 1;
  while (taken.has(`${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

/** The deadline most raters of a role have, as the default for a new one. */
export function usualDeadline(overview: Overview, role: Role): string {
  const counts = new Map<string, number>();
  for (const rater of overview.raters) {
    if (rater.role === role && rater.deadline !== null) {
      counts.set(rater.deadline, (counts.get(rater.deadline) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
