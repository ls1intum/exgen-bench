const MOMENT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A point in time in the reader's time zone, such as a rater's last activity. */
export function moment(at: string): string {
  return MOMENT.format(new Date(at));
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How long ago a moment was, such as "3 hours ago"; precise enough to follow a study's progress. */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.round((new Date(at).getTime() - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}

/** Whole days since a moment. */
export function daysSince(at: string, now = Date.now()): number {
  return Math.floor((now - new Date(at).getTime()) / 86_400_000);
}

/** Today as yyyy-MM-dd in UTC, the form deadlines take. */
export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
