import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Post, PostInput } from "@threadflow/shared";
import { POST_CHARACTER_LIMIT } from "@threadflow/shared";
import {
  CalendarDays,
  Check,
  Clock3,
  Plus,
  Send,
  UsersRound,
} from "lucide-react";
import { DateTime } from "luxon";
import { toast } from "sonner";
import { api, messageOf } from "../api";
import {
  Avatar,
  Button,
  Checkmark,
  ErrorState,
  LoadingRows,
  Modal,
} from "../ui";
import { defaultSchedule, pickerToUtc } from "../time";
import { useWorkspace } from "../workspace-context";
import { DateTimePicker } from "./DateTimePicker";
import { postNeedsConfirmation } from "../publication-status";

export function Composer({
  post,
  initialDate,
  onClose,
}: {
  post?: Post;
  initialDate?: string;
  onClose: () => void;
}) {
  const { user, refresh } = useWorkspace();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const connected =
    accounts.data?.filter((account) => account.status === "connected") || [];
  const initialInstant =
    post?.scheduledAt || (initialDate?.includes("T") ? initialDate : null);
  const initial = defaultSchedule(user.timezone);
  if (initialInstant) {
    const zoned = DateTime.fromISO(initialInstant, { zone: user.timezone });
    initial.day = zoned.toFormat("yyyy-MM-dd");
    initial.time = zoned.toFormat("HH:mm");
  }
  const [content, setContent] = useState(post?.content || "");
  const [selected, setSelected] = useState<string[]>(
    post?.targets.map((target) => target.socialAccountId) || [],
  );
  const [mode, setMode] = useState<"now" | "schedule">(
    post?.status === "scheduled" || initialDate ? "schedule" : "now",
  );
  const [day, setDay] = useState(initialDate?.slice(0, 10) || initial.day);
  const [time, setTime] = useState(initial.time);
  const [pending, setPending] = useState<"draft" | "publish" | null>(null);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | undefined>(post?.id);
  const selectedConnected = selected.filter((id) =>
    connected.some((account) => account.id === id),
  );
  const characterCount = Array.from(content).length;
  const needsConfirmation = !!post && postNeedsConfirmation(post);
  const invalid =
    needsConfirmation ||
    !content.trim() ||
    characterCount > POST_CHARACTER_LIMIT ||
    !selectedConnected.length;

  async function save(draft: boolean) {
    setError("");
    if (needsConfirmation)
      return setError("Check this post in Threads before creating another copy. Its publication needs confirmation.");
    if (!content.trim())
      return setError("Write something before saving your post.");
    if (characterCount > POST_CHARACTER_LIMIT)
      return setError(
        `Threads posts can contain up to ${POST_CHARACTER_LIMIT} characters.`,
      );
    if (!selectedConnected.length)
      return setError("Choose at least one connected account.");
    setPending(draft ? "draft" : "publish");
    try {
      const scheduled = !draft && mode === "schedule";
      const input: PostInput = {
        content: content.trim(),
        accountIds: selectedConnected,
        timezone: user.timezone,
        status: scheduled ? "scheduled" : "draft",
        scheduledAt: scheduled ? pickerToUtc(day, time, user.timezone) : null,
      };
      const saved = savedId
        ? await api.updatePost(savedId, input)
        : await api.createPost(input);
      setSavedId(saved.id);
      if (!draft && mode === "now") await api.publishNow(saved.id);
      await refresh();
      toast.success(
        draft
          ? "Draft saved"
          : scheduled
            ? "Post scheduled"
            : "Your post is publishing",
        {
          description: draft
            ? "Come back whenever your idea is ready."
            : scheduled
              ? `${DateTime.fromISO(input.scheduledAt!, { zone: user.timezone }).toFormat("MMM d · HH:mm")} · ${selectedConnected.length} ${selectedConnected.length === 1 ? "account" : "accounts"}`
              : "Follow each account’s result in Posts.",
        },
      );
      onClose();
    } catch (error) {
      setError(messageOf(error));
      await refresh();
    } finally {
      setPending(null);
    }
  }
  function toggle(id: string) {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={post ? "Edit your post" : "A new conversation starts here"}
      description={
        post
          ? "Refine your words and choose the right moment."
          : "Write once. Share with the accounts that matter."
      }
      wide
    >
      <div className="composer-body">
        <div className="composer-section">
          <div className="section-label">
            <label htmlFor="post-content">Your post</label>
            <span
              className={`character-count ${characterCount > POST_CHARACTER_LIMIT ? "over-limit" : ""}`}
            >
              {characterCount}
              <span> / {POST_CHARACTER_LIMIT}</span>
            </span>
          </div>
          <div className="composer-textarea-wrap">
            <textarea
              id="post-content"
              placeholder="What’s on your mind? Start a conversation…"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              autoFocus
              disabled={!!pending}
              aria-describedby="post-character-help"
            />
            <div className="textarea-footer">
              <span id="post-character-help">Text posts for Threads</span>
              <span className="threads-glyph">@</span>
            </div>
          </div>
        </div>
        <div className="composer-section">
          <div className="section-label">
            <span>
              <UsersRound size={16} />
              Share to
            </span>
            {connected.length > 0 && (
              <button
                type="button"
                className="plain-link"
                disabled={!!pending}
                onClick={() =>
                  setSelected(
                    selectedConnected.length === connected.length
                      ? []
                      : connected.map((account) => account.id),
                  )
                }
              >
                {selectedConnected.length === connected.length
                  ? "Deselect all"
                  : "Select all"}
              </button>
            )}
          </div>
          {accounts.isPending ? (
            <LoadingRows count={2} />
          ) : accounts.error ? (
            <ErrorState
              error={accounts.error}
              retry={() => void accounts.refetch()}
            />
          ) : connected.length ? (
            <div className="account-choices">
              {connected.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={!!pending}
                  className={`account-choice ${selected.includes(account.id) ? "selected" : ""}`}
                  onClick={() => toggle(account.id)}
                  aria-pressed={selected.includes(account.id)}
                >
                  <Avatar account={account} />
                  <span>
                    <strong>{account.displayName}</strong>
                    <small>@{account.username}</small>
                  </span>
                  <Checkmark checked={selected.includes(account.id)} />
                </button>
              ))}
            </div>
          ) : (
            <div className="compose-no-accounts">
              <UsersRound size={22} />
              <p>Connect a Threads account to share your first post.</p>
              <Link
                to="/accounts"
                onClick={onClose}
                className="button button-secondary"
              >
                <Plus size={15} />
                Connect an account
              </Link>
            </div>
          )}
          {post?.targets.some(
            (target) => target.account.status !== "connected",
          ) && (
            <p className="field-hint">
              Disconnected accounts won’t be included. Reconnect them in
              Accounts to select them again.
            </p>
          )}
          <p className="field-hint">
            Each selected profile is checked in Threads before sending. If a login
            or SMS check is required, that account’s post stops with an explanation.
          </p>
        </div>
        <div className="composer-section">
          <div className="section-label">
            <span>Find your moment</span>
          </div>
          <div className="publish-modes">
            <button
              type="button"
              disabled={!!pending}
              onClick={() => setMode("now")}
              aria-pressed={mode === "now"}
              className={mode === "now" ? "selected" : ""}
            >
              <Send size={18} />
              <span>
                <strong>Publish now</strong>
                <small>Start the conversation</small>
              </span>
              {mode === "now" && <Check size={17} />}
            </button>
            <button
              type="button"
              disabled={!!pending}
              onClick={() => setMode("schedule")}
              aria-pressed={mode === "schedule"}
              className={mode === "schedule" ? "selected" : ""}
            >
              <CalendarDays size={18} />
              <span>
                <strong>Schedule</strong>
                <small>Pick a time that works</small>
              </span>
              {mode === "schedule" && <Check size={17} />}
            </button>
          </div>
          {mode === "schedule" && (
            <DateTimePicker
              day={day}
              time={time}
              timezone={user.timezone}
              onDayChange={setDay}
              onTimeChange={setTime}
              disabled={!!pending}
            />
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {needsConfirmation && (
          <p className="field-hint">
            This post may already be in Threads. Saving or sending it again is
            disabled until its publication is confirmed.
          </p>
        )}
      </div>
      <footer className="composer-footer">
        <span>
          {selectedConnected.length ? (
            <>
              <Check size={14} />
              {selectedConnected.length}{" "}
              {selectedConnected.length === 1
                ? "account selected"
                : "accounts selected"}
            </>
          ) : (
            "Choose your accounts"
          )}
        </span>
        <div>
          <Button
            variant="secondary"
            onClick={() => void save(true)}
            loading={pending === "draft"}
            disabled={!!pending || invalid}
          >
            Save draft
          </Button>
          <Button
            onClick={() => void save(false)}
            loading={pending === "publish"}
            disabled={!!pending || invalid}
          >
            {mode === "schedule" ? <Clock3 size={16} /> : <Send size={16} />}
            {mode === "schedule" ? "Schedule post" : "Publish now"}
          </Button>
        </div>
      </footer>
    </Modal>
  );
}
