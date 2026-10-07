import assert from "node:assert/strict";
import test from "node:test";
import { DateTime } from "luxon";
import { pickerToUtc, dateLabel, timeLabel } from "../apps/web/src/time.js";

test("a Shanghai calendar selection is persisted as the corresponding UTC instant", () => {
  assert.equal(
    pickerToUtc("2030-10-10", "14:30", "Asia/Shanghai"),
    "2030-10-10T06:30:00.000Z",
  );
});

test("a skipped daylight-saving time cannot silently move a scheduled publication", () => {
  assert.throws(
    () => pickerToUtc("2030-03-10", "02:30", "America/New_York"),
    /does not exist/,
  );
});

test("a repeated daylight-saving time preserves the selected wall time on UTC roundtrip", () => {
  const utc = pickerToUtc("2030-11-03", "01:30", "America/New_York");
  const local = DateTime.fromISO(utc, { zone: "America/New_York" });
  assert.equal(local.toFormat("yyyy-MM-dd HH:mm"), "2030-11-03 01:30");
});

test("a publication crossing local midnight displays on the correct date", () => {
  assert.equal(
    dateLabel("2030-10-10T18:30:00.000Z", "Asia/Shanghai", "yyyy-MM-dd"),
    "2030-10-11",
  );
  assert.equal(timeLabel("2030-10-10T18:30:00.000Z", "Asia/Shanghai"), "02:30");
});

test("invalid zones and dates and past times cannot be scheduled", () => {
  assert.throws(() => pickerToUtc("2030-10-10", "14:30", "Invalid/Zone"));
  assert.throws(() => pickerToUtc("2030-02-30", "14:30", "UTC"));
  assert.throws(() => pickerToUtc("2020-01-01", "14:30", "UTC"), /future/);
});
