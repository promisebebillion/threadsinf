import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { CalendarDays, ChevronDown, Clock3, Globe2 } from "lucide-react";
import { DateTime } from "luxon";

export function DateTimePicker({
  day,
  time,
  timezone,
  onDayChange,
  onTimeChange,
  disabled = false,
}: {
  day: string;
  time: string;
  timezone: string;
  onDayChange: (day: string) => void;
  onTimeChange: (time: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = day ? new Date(`${day}T12:00:00`) : undefined;
  const today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");
  return (
    <div className="schedule-picker">
      <div className="datetime-fields">
        <div className="field">
          <span>Date</span>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="picker-button"
                disabled={disabled}
              >
                <CalendarDays size={17} />
                <span>
                  {day
                    ? DateTime.fromISO(day).toFormat("MMMM d, yyyy")
                    : "Choose a date"}
                </span>
                <ChevronDown size={15} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="date-popover"
                align="start"
                sideOffset={8}
              >
                <DayPicker
                  mode="single"
                  selected={selected}
                  defaultMonth={selected}
                  disabled={{ before: new Date(`${today}T00:00:00`) }}
                  onSelect={(date) => {
                    if (date) {
                      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                      onDayChange(iso);
                      setOpen(false);
                    }
                  }}
                />
                <Popover.Arrow className="popover-arrow" />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
        <label className="field">
          <span>Time</span>
          <span className="time-input">
            <Clock3 size={17} />
            <input
              type="time"
              value={time}
              onChange={(e) => onTimeChange(e.target.value)}
              required
              disabled={disabled}
              aria-label="Publication time"
            />
          </span>
        </label>
      </div>
      <p className="timezone-note">
        <Globe2 size={13} />
        Scheduled in {timezone.replaceAll("_", " ")}
      </p>
    </div>
  );
}
