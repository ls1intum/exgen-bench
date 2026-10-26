/** A calendar date such as a deadline, shown as the same day in every time zone. */
export function calendarDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { timeZone: "UTC" });
}
