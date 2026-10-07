import type { Post } from "@threadflow/shared";
import { ChevronRight, Clock3 } from "lucide-react";
import { AccountStack, StatusBadge } from "../ui";
import { dateLabel, timeLabel } from "../time";
import { useWorkspace } from "../workspace-context";
import { displayPostStatus } from "../publication-status";

export function PostRow({
  post,
  compact = false,
}: {
  post: Post;
  compact?: boolean;
}) {
  const { user, viewPost } = useWorkspace();
  const accounts = post.targets.map((target) => target.account);
  const publishedAt = post.targets.find(
    (target) => target.publishedAt,
  )?.publishedAt;
  const time =
    post.status === "published"
      ? publishedAt || post.scheduledAt
      : post.scheduledAt;
  return (
    <button
      className={`post-row ${compact ? "compact" : ""}`}
      onClick={() => viewPost(post.id)}
    >
      <div className="post-row-date">
        {time ? (
          <>
            <strong>{dateLabel(time, user.timezone, "d")}</strong>
            <span>{dateLabel(time, user.timezone, "MMM")}</span>
          </>
        ) : (
          <Clock3 size={20} />
        )}
      </div>
      <div className="post-row-main">
        <p>{post.content}</p>
        <div className="post-row-accounts">
          <AccountStack accounts={accounts} />
          <span>
            {accounts.length === 1
              ? `@${accounts[0].username}`
              : `${accounts.length} accounts`}
          </span>
          {time && (
            <>
              <i />{" "}
              <span>
                {timeLabel(time, user.timezone)}
                {!compact && ` · ${dateLabel(time, user.timezone, "MMM d")}`}
              </span>
            </>
          )}
        </div>
      </div>
      <StatusBadge status={displayPostStatus(post)} />
      <ChevronRight size={17} className="row-chevron" />
    </button>
  );
}
