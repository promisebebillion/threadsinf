import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  CalendarDays,
  CheckCheck,
  CircleAlert,
  Clock3,
  Plus,
  UsersRound,
} from "lucide-react";
import { DateTime } from "luxon";
import { api } from "../api";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeading,
  SmallLink,
} from "../ui";
import { useWorkspace } from "../workspace-context";
import { PostRow } from "../components/PostRow";

export function DashboardPage() {
  const { user, createPost } = useWorkspace();
  const navigate = useNavigate();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    refetchInterval: 5000,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const hour = DateTime.now().setZone(user.timezone).hour;
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const metrics = [
    {
      label: "Verified accounts",
      value: dashboard.data?.connectedAccounts,
      icon: UsersRound,
      route: "/accounts",
      tone: "sage",
    },
    {
      label: "Scheduled posts",
      value: dashboard.data?.scheduledPosts,
      icon: Clock3,
      route: "/posts?status=scheduled",
      tone: "sky",
    },
    {
      label: "Published posts",
      value: dashboard.data?.publishedPosts,
      icon: CheckCheck,
      route: "/posts?status=published",
      tone: "violet",
    },
    {
      label: "Need attention",
      value: dashboard.data?.failedPosts,
      icon: CircleAlert,
      route: "/posts",
      tone: "peach",
    },
  ];
  return (
    <>
      <PageHeading
        title={`${greeting}, ${user.name.split(" ")[0]}.`}
        description="A little planning. More room for the conversations that matter."
        eyebrow={DateTime.now().setZone(user.timezone).toFormat("cccc, MMMM d")}
        action={
          <Button onClick={() => createPost()}>
            <Plus size={18} />
            Create post
          </Button>
        }
      />
      {dashboard.error ? (
        <ErrorState
          error={dashboard.error}
          retry={() => void dashboard.refetch()}
        />
      ) : (
        <>
          <div className="metric-strip">
            {metrics.map((metric) => (
              <button
                className="metric"
                key={metric.label}
                onClick={() => navigate(metric.route)}
              >
                <div>
                  <span className={`metric-icon metric-${metric.tone}`}>
                    <metric.icon size={19} />
                  </span>
                  <ArrowUpRight size={16} />
                </div>
                <strong>
                  {dashboard.isPending ? (
                    <span className="skeleton metric-skeleton" />
                  ) : (
                    metric.value
                  )}
                </strong>
                <span>{metric.label}</span>
              </button>
            ))}
          </div>
          <div className="dashboard-grid">
            <section className="panel upcoming-panel">
              <div className="panel-heading">
                <div>
                  <h2>Coming up next</h2>
                  <p>Your ideas have a time and a place.</p>
                </div>
                <SmallLink onClick={() => navigate("/calendar")}>
                  View calendar
                </SmallLink>
              </div>
              {dashboard.isPending ? (
                <LoadingRows count={3} />
              ) : dashboard.data?.upcomingPosts.length ? (
                <div className="post-list">
                  {dashboard.data.upcomingPosts.map((post) => (
                    <PostRow key={post.id} post={post} compact />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="Your next conversation is waiting"
                  description="Give your ideas a place on the calendar. We’ll take care of publishing when it’s time."
                  icon={<CalendarDays size={27} />}
                  action={
                    <Button variant="secondary" onClick={() => createPost()}>
                      <Plus size={16} />
                      Schedule a post
                    </Button>
                  }
                />
              )}
              <div className="panel-bottom">
                <Clock3 size={14} />
                <span>
                  All times are shown in {user.timezone.replaceAll("_", " ")}.
                </span>
              </div>
            </section>
            <aside className="dashboard-aside">
              <section className="panel channels-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Your accounts</h2>
                    <p>One workspace. Every voice.</p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Manage accounts"
                    onClick={() => navigate("/accounts")}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
                {accounts.isPending ? (
                  <LoadingRows count={2} />
                ) : accounts.error ? (
                  <ErrorState
                    error={accounts.error}
                    retry={() => void accounts.refetch()}
                  />
                ) : accounts.data?.filter(
                    (account) => account.status === "connected",
                  ).length ? (
                  <div className="dashboard-account-list">
                    {accounts.data
                      .filter((account) => account.status === "connected")
                      .slice(0, 4)
                      .map((account) => (
                        <button
                          className="dashboard-account"
                          key={account.id}
                          onClick={() => navigate("/accounts")}
                        >
                          <Avatar account={account} />
                          <span>
                            <strong>{account.displayName}</strong>
                            <small>@{account.username}</small>
                          </span>
                          <span className="connection-dot" />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="channels-empty">
                    <span className="empty-icon">
                      <UsersRound size={24} />
                    </span>
                    <p>Bring your Threads accounts together.</p>
                  </div>
                )}
                <Button
                  variant="secondary"
                  onClick={() => navigate("/accounts")}
                >
                  <Plus size={15} />
                  Connect account
                </Button>
              </section>
              <div className="planning-note">
                <CalendarDays size={24} />
                <h3>A week with a little breathing room.</h3>
                <p>
                  Find a good moment for every idea. Your calendar makes the
                  bigger picture easier to see.
                </p>
                <button
                  className="text-link"
                  onClick={() => navigate("/calendar")}
                >
                  Plan your week
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </aside>
          </div>
          <section className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent activity</h2>
                <p>The latest from your publishing workspace.</p>
              </div>
              <SmallLink onClick={() => navigate("/posts")}>
                All posts
              </SmallLink>
            </div>
            {dashboard.isPending ? (
              <LoadingRows count={2} />
            ) : dashboard.data?.recentPosts.length ? (
              <div className="post-list">
                {dashboard.data.recentPosts.slice(0, 4).map((post) => (
                  <PostRow key={post.id} post={post} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="A fresh start"
                description="Drafts, scheduled posts, and published conversations will appear here."
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
