import { DateTime } from "luxon";

export const browserTimezone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const allTimezones = Array.from(
  new Set([browserTimezone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
).sort();
export const zonedDate = (iso: string, zone: string) =>
  DateTime.fromISO(iso, { zone });
export const dateLabel = (
  iso: string | null,
  zone: string,
  format = "MMM d, yyyy",
) => (iso ? zonedDate(iso, zone).toFormat(format) : "Unscheduled");
export const timeLabel = (iso: string | null, zone: string) =>
  iso ? zonedDate(iso, zone).toFormat("HH:mm") : "";
export const fullDateLabel = (iso: string | null, zone: string) =>
  iso ? zonedDate(iso, zone).toFormat("MMM d, yyyy · HH:mm") : "No date set";
export const prettyZone = (zone: string) =>
  zone.replaceAll("_", " ").split("/").at(-1) || zone;

export function pickerToUtc(day: string, time: string, zone: string): string {
  const date = DateTime.fromISO(`${day}T${time}`, { zone });
  if (!date.isValid || date.toFormat("yyyy-MM-dd HH:mm") !== `${day} ${time}`)
    throw new Error(
      "This time does not exist in your timezone. Choose another time.",
    );
  if (date.toMillis() <= Date.now())
    throw new Error("Choose a time in the future.");
  return date.toUTC().toISO()!;
}

export function defaultSchedule(zone: string) {
  const time = DateTime.now()
    .setZone(zone)
    .plus({ minutes: 30 })
    .startOf("minute");
  return { day: time.toFormat("yyyy-MM-dd"), time: time.toFormat("HH:mm") };
}
