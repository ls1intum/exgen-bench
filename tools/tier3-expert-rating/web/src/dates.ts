const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const MOMENT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A calendar date such as a deadline, shown as the same day in every time zone ("Dec 31, 2026"). */
export function calendarDate(date: string): string {
  return DAY.format(new Date(date));
}

/** A point in time in the reader's time zone, such as a rater's last activity. */
export function moment(at: string): string {
  return MOMENT.format(new Date(at));
}
