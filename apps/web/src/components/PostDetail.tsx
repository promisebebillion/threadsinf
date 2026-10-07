import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, Clock3, Pencil, Send, Trash2 } from "lucide-react";
import { DateTime } from "luxon";
import { toast } from "sonner";
import { api, messageOf } from "../api";
import {
  Avatar,
  Button,
  ConfirmDialog,
  ErrorState,
  LoadingRows,
  Modal,
  StatusBadge,
} from "../ui";
import { defaultSchedule, fullDateLabel, pickerToUtc } from "../time";
import { useWorkspace } from "../workspace-context";
import { DateTimePicker } from "./DateTimePicker";
import { displayPostStatus, postNeedsConfirmation, targetNeedsConfirmation } from "../publication-status";

export function PostDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { user, editPost, refresh } = useWorkspace();
  const query = useQuery({
    queryKey: ["post", id],
    queryFn: () => api.post(id),
    refetchInterval: 3000,
  });
  const post = query.data;
  const [rescheduling, setRescheduling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [day, setDay] = useState(defaultSchedule(user.timezone).day);
  const [time, setTime] = useState(defaultSchedule(user.timezone).time);
  const [pending, setPending] = useState<
    "publish" | "cancel" | "schedule" | null
  >(null);
  const [error, setError] = useState("");
  const needsConfirmation = !!post && postNeedsConfirmation(post);
  const actionable =
    post && !needsConfirmation && ["draft", "scheduled", "failed"].includes(post.status);
  const editable =
    actionable && !post.targets.some((target) => target.status === "published");
  const publishable =
    !!post?.targets.length &&
    post.targets.every((target) => target.account.status === "connected");
  async function act(kind: "publish" | "cancel" | "schedule") {
    if (needsConfirmation) return;
    setPending(kind);
    setError("");
    try {
      if (kind === "publish") await api.publishNow(id);
      else if (kind === "cancel") await api.cancelPost(id);
      else
        await api.reschedule(
          id,
          pickerToUtc(day, time, user.timezone),
          user.timezone,
        );
      await refresh();
      toast.success(
        kind === "publish"
          ? "Your post is publishing"
          : kind === "cancel"
            ? "Post cancelled"
            : "Publication time updated",
      );
      setConfirm(false);
      setRescheduling(false);
    } catch (error) {
      setError(messageOf(error));
      setConfirm(false);
    } finally {
      setPending(null);
    }
  }
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open && !pending) onClose();
        }}
        title="Post details"
        description="Your content and delivery results, all in one place."
        wide
      >
        {query.isPending ? (
          <div className="detail-body">
            <LoadingRows />
          </div>
        ) : query.error ? (
          <div className="detail-body">
            <ErrorState
              error={query.error}
              retry={() => void query.refetch()}
            />
          </div>
        ) : (
          post && (
            <>
              <div className="detail-body">
                <div className="detail-status-line">
                  <StatusBadge status={displayPostStatus(post)} />
                  <span>
                    Created {fullDateLabel(post.createdAt, user.timezone)}
                  </span>
                </div>
                <p className="post-full-content">{post.content}</p>
                <div className="detail-timing">
                  <CalendarDays size={19} />
                  <div>
                    <strong>
                      {post.scheduledAt
                        ? fullDateLabel(post.scheduledAt, user.timezone)
                        : post.status === "draft"
                          ? "Ready when you are"
                          : post.status === "published"
                            ? "Published without a scheduled time"
                            : "Sent without a scheduled time"}
                    </strong>
                    <span>{user.timezone.replaceAll("_", " ")}</span>
                  </div>
                </div>
                <div className="section-label">
                  <span>Account results</span>
                  <small>
                    {post.targets.length}{" "}
                    {post.targets.length === 1 ? "account" : "accounts"}
                  </small>
                </div>
                <div className="target-results">
                  {post.targets.map((target) => (
                    <div className="target-result" key={target.id}>
                      <div className="target-result-top">
                        <Avatar account={target.account} />
                        <div>
                          <strong>{target.account.displayName}</strong>
                          <small>@{target.account.username}</small>
                        </div>
                        <StatusBadge status={targetNeedsConfirmation(target) ? "unconfirmed" : target.status} />
                      </div>
                      <div className="target-result-meta">
                        <span>
                          {target.attempts}{" "}
                          {target.attempts === 1 ? "attempt" : "attempts"}
                        </span>
                        {target.publishedAt && (
                          <span>
                            Published{" "}
                            {fullDateLabel(target.publishedAt, user.timezone)}
                          </span>
                        )}
                        {target.lastAttemptAt && !target.publishedAt && (
                          <span>
                            Last attempt{" "}
                            {fullDateLabel(target.lastAttemptAt, user.timezone)}
                          </span>
                        )}
                      </div>
                      {target.errorMessage && (
                        <p className={targetNeedsConfirmation(target) ? "target-warning" : "target-error"}>{target.errorMessage}</p>
                      )}
                      {target.externalPostId && (
                        <p className="external-id">
                          {target.status === "published" && /^https:\/\/(?:www\.)?threads\.(?:com|net)\/@[^/?#]+\/post\/[^/?#]+(?:[?#].*)?$/i.test(target.externalPostId) ? (
                            <a href={target.externalPostId} target="_blank" rel="noopener noreferrer" className="text-link">
                              View published post <ArrowUpRight size={13} />
                            </a>
                          ) : (
                            <>Publication ID: {target.externalPostId}</>
                          )}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {needsConfirmation && (
                  <p className="field-hint">
                    Threads may already contain this post. Check the account’s
                    profile before creating another copy. Sending, editing, and
                    rescheduling this post are disabled to prevent duplicates.
                  </p>
                )}
                {post.status === "failed" && !needsConfirmation && (
                  <p className="field-hint">
                    Retry only sends to accounts that haven’t published
                    successfully. Successful deliveries are preserved.
                  </p>
                )}
                {!publishable && actionable && (
                  <p className="field-hint">
                    Select an account by editing this post, or reconnect its
                    expired session in Accounts before publishing.
                  </p>
                )}
                {rescheduling && (
                  <section className="reschedule-section">
                    <div className="section-label">
                      <span>
                        <Clock3 size={16} />
                        Choose a new time
                      </span>
                    </div>
                    <DateTimePicker
                      day={day}
                      time={time}
                      timezone={user.timezone}
                      onDayChange={setDay}
                      onTimeChange={setTime}
                      disabled={!!pending}
                    />
                    <div className="reschedule-actions">
                      <Button
                        variant="ghost"
                        onClick={() => setRescheduling(false)}
                        disabled={!!pending}
                      >
                        Keep current time
                      </Button>
                      <Button
                        onClick={() => void act("schedule")}
                        loading={pending === "schedule"}
                        disabled={!!pending}
                      >
                        Save new time
                      </Button>
                    </div>
                  </section>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <footer className="detail-footer">
                {actionable ? (
                  <>
                    <Button
                      variant="ghost"
                      className="cancel-button"
                      onClick={() => setConfirm(true)}
                      disabled={!!pending}
                    >
                      <Trash2 size={16} />
                      Cancel post
                    </Button>
                    <div>
                      {editable && (
                        <Button
                          variant="secondary"
                          onClick={() => editPost(post)}
                          disabled={!!pending}
                        >
                          <Pencil size={15} />
                          Edit
                        </Button>
                      )}
                      {editable && publishable && (
                        <Button
                          variant="secondary"
                          disabled={!!pending}
                          onClick={() => {
                            if (post.scheduledAt) {
                              const scheduled = DateTime.fromISO(
                                post.scheduledAt,
                                { zone: user.timezone },
                              );
                              setDay(scheduled.toFormat("yyyy-MM-dd"));
                              setTime(scheduled.toFormat("HH:mm"));
                            }
                            setRescheduling(!rescheduling);
                          }}
                        >
                          <CalendarDays size={15} />
                          Reschedule
                        </Button>
                      )}
                      <Button
                        onClick={() => void act("publish")}
                        loading={pending === "publish"}
                        disabled={!!pending || !publishable}
                      >
                        <Send size={15} />
                        {post.status === "failed"
                          ? "Retry publication"
                          : "Publish now"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="field-hint">
                      {post.status === "publishing"
                        ? "Your post is being delivered. Results update automatically."
                        : needsConfirmation
                          ? "The publication result needs confirmation in Threads."
                          : "This post is part of your publishing history."}
                    </span>
                    <Button variant="secondary" onClick={onClose}>
                      Done
                    </Button>
                  </>
                )}
              </footer>
            </>
          )
        )}
      </Modal>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel this post?"
        description="This stops any remaining scheduled deliveries. The post and its delivery history stay in your workspace."
        confirmLabel="Cancel post"
        pending={pending === "cancel"}
        onConfirm={() => void act("cancel")}
      />
    </>
  );
}
