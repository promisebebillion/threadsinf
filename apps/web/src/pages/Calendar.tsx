import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import luxonPlugin from "@fullcalendar/luxon3";
import { ChevronLeft, ChevronRight, Globe2, Plus } from "lucide-react";
import { DateTime } from "luxon";
import { toast } from "sonner";
import type { Post } from "@threadflow/shared";
import { api, messageOf } from "../api";
import { Avatar, Button, ErrorState, PageHeading, useMobile } from "../ui";
import { timeLabel } from "../time";
import { useWorkspace } from "../workspace-context";
import { displayPostStatus, postNeedsConfirmation } from "../publication-status";

export function CalendarPage() {
  const { user, createPost, viewPost, refresh } = useWorkspace();
  const mobile = useMobile();
  const calendar = useRef<FullCalendar>(null);
  const [view, setView] = useState("dayGridMonth");
  const [title, setTitle] = useState(
    DateTime.now().setZone(user.timezone).toFormat("MMMM yyyy"),
  );
  const [range, setRange] = useState({
    start: DateTime.now()
      .setZone(user.timezone)
      .startOf("month")
      .minus({ weeks: 1 })
      .toUTC()
      .toISO()!,
    end: DateTime.now()
      .setZone(user.timezone)
      .endOf("month")
      .plus({ weeks: 1 })
      .toUTC()
      .toISO()!,
  });
  const [accountId, setAccountId] = useState("");
  const [moving, setMoving] = useState(false);
  const query = useQuery({
    queryKey: ["calendar", range.start, range.end],
    queryFn: () => api.calendar(range.start, range.end),
    refetchInterval: 5000,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      calendar.current?.getApi().changeView(mobile ? "listWeek" : view);
    });
    return () => cancelAnimationFrame(frame);
  }, [mobile, view]);
  const posts =
    query.data?.filter(
      (post) =>
        !accountId ||
        post.targets.some((target) => target.socialAccountId === accountId),
    ) || [];
  return (
    <>
      <PageHeading
        title="Give your ideas a little space."
        description={
          mobile
            ? "Your week ahead, one conversation at a time."
            : "A clear view of what’s coming. Move a scheduled post to change its time."
        }
        action={
          <Button onClick={() => createPost()}>
            <Plus size={18} />
            Create post
          </Button>
        }
      />
      <section className="panel calendar-panel">
        <div className="calendar-toolbar">
          <div className="calendar-navigation">
            <Button
              variant="secondary"
              className="today-button"
              onClick={() => calendar.current?.getApi().today()}
            >
              Today
            </Button>
            <div className="calendar-arrows">
              <button
                className="icon-button"
                aria-label="Previous period"
                onClick={() => calendar.current?.getApi().prev()}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="Next period"
                onClick={() => calendar.current?.getApi().next()}
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <h2>{title}</h2>
          </div>
          <div className="calendar-controls">
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="account-filter"
              aria-label="Filter calendar by account"
            >
              <option value="">All accounts</option>
              {accounts.data?.map((account) => (
                <option value={account.id} key={account.id}>
                  @{account.username}
                </option>
              ))}
            </select>
            {!mobile && (
              <div className="calendar-view-toggle">
                {[
                  { name: "Month", id: "dayGridMonth" },
                  { name: "Week", id: "timeGridWeek" },
                  { name: "Day", id: "timeGridDay" },
                ].map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setView(option.id)}
                    className={view === option.id ? "active" : ""}
                    aria-pressed={view === option.id}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {query.error && (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        )}
        {query.isPending && (
          <div className="calendar-loading" aria-live="polite">
            Loading your calendar…
          </div>
        )}
        <div
          className={
            moving ? "calendar-content calendar-moving" : "calendar-content"
          }
          aria-busy={query.isPending}
        >
          <FullCalendar
            ref={calendar}
            plugins={[
              dayGridPlugin,
              timeGridPlugin,
              listPlugin,
              interactionPlugin,
              luxonPlugin,
            ]}
            timeZone={user.timezone}
            initialView={mobile ? "listWeek" : "dayGridMonth"}
            headerToolbar={false}
            height="auto"
            firstDay={1}
            nowIndicator
            editable={!moving && !mobile}
            eventDurationEditable={false}
            droppable={false}
            dayMaxEvents={3}
            fixedWeekCount={false}
            slotMinTime="00:00:00"
            scrollTime="08:00:00"
            slotMaxTime="24:00:00"
            allDaySlot={false}
            eventTimeFormat={{
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }}
            slotLabelFormat={{
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }}
            datesSet={(info) => {
              setTitle(info.view.title);
              const next = {
                start: info.start.toISOString(),
                end: info.end.toISOString(),
              };
              setRange((previous) =>
                previous.start === next.start && previous.end === next.end
                  ? previous
                  : next,
              );
            }}
            events={posts
              .filter((post) => post.scheduledAt)
              .map((post) => ({
                id: post.id,
                title: post.content,
                start: post.scheduledAt!,
                editable: post.status === "scheduled" && !postNeedsConfirmation(post) && !moving,
                durationEditable: false,
                classNames: [`calendar-event-${displayPostStatus(post)}`],
                extendedProps: { post },
              }))}
            dateClick={(info) => createPost(info.dateStr)}
            eventClick={(info) => viewPost(info.event.id)}
            eventDrop={async (info) => {
              if (!info.event.start) return info.revert();
              setMoving(true);
              try {
                await api.reschedule(
                  info.event.id,
                  info.event.start.toISOString(),
                  user.timezone,
                );
                await refresh();
                toast.success("Publication time updated");
              } catch (error) {
                info.revert();
                toast.error(messageOf(error));
              } finally {
                setMoving(false);
              }
            }}
            eventContent={(info) => {
              const post = info.event.extendedProps.post as Post;
              const account = post.targets[0]?.account;
              return (
                <div className="calendar-event-content">
                  <div className="calendar-event-top">
                    <span>{timeLabel(post.scheduledAt, user.timezone)}</span>
                    <span className={`status-dot event-dot-${displayPostStatus(post)}`} />
                  </div>
                  <p>{post.content}</p>
                  {account && (
                    <div className="calendar-event-account">
                      <Avatar account={account} size="small" />
                      <span>
                        @{account.username}
                        {post.targets.length > 1
                          ? ` +${post.targets.length - 1}`
                          : ""}
                      </span>
                    </div>
                  )}
                </div>
              );
            }}
            noEventsContent={
              query.isPending ? (
                <div className="agenda-empty" aria-hidden="true" />
              ) : query.error ? (
                <div className="agenda-empty">
                  <p>Your calendar is temporarily unavailable.</p>
                </div>
              ) : (
                <div className="agenda-empty">
                  <p>No posts planned for this week.</p>
                  <Button variant="secondary" onClick={() => createPost()}>
                    <Plus size={15} />
                    Schedule something
                  </Button>
                </div>
              )
            }
          />
        </div>
        <div className="calendar-footer">
          <div className="calendar-legend">
            <span>
              <i className="scheduled" />
              Scheduled
            </span>
            <span>
              <i className="published" />
              Published
            </span>
            <span>
              <i className="unconfirmed" />
              Needs confirmation
            </span>
            <span>
              <i className="failed" />
              Failed
            </span>
          </div>
          <span className="calendar-zone">
            <Globe2 size={14} />
            {user.timezone.replaceAll("_", " ")}
          </span>
        </div>
      </section>
      <p className="calendar-tip">
        {mobile
          ? "Tap a post to edit its content, change the time, or view delivery results."
          : "Click a date to start a post. Drag scheduled posts to find a better moment."}
      </p>
    </>
  );
}
