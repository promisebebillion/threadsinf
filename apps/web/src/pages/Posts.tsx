import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, Search, X } from "lucide-react";
import { api } from "../api";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeading,
} from "../ui";
import { useWorkspace } from "../workspace-context";
import { PostRow } from "../components/PostRow";
import { postStatusLabel } from "../publication-status";

const statuses = [
  "all",
  "scheduled",
  "published",
  "unconfirmed",
  "failed",
  "draft",
  "publishing",
  "cancelled",
];

export function PostsPage() {
  const { createPost } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const status = statuses.includes(params.get("status") || "")
    ? params.get("status")!
    : "all";
  const [search, setSearch] = useState(params.get("search") || "");
  const [debounced, setDebounced] = useState(search);
  const accountId = params.get("accountId") || "";
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timeout);
  }, [search]);
  const query = useQuery({
    queryKey: ["posts", status, accountId, debounced],
    queryFn: () =>
      api.posts({
        status: status === "all" ? "" : status,
        accountId,
        search: debounced,
      }),
    refetchInterval: 5000,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const filtered = status !== "all" || accountId || debounced;
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <PageHeading
        title="Every conversation, together."
        description="Keep an eye on your drafts, plans, and published posts."
        action={
          <Button onClick={() => createPost()}>
            <Plus size={18} />
            Create post
          </Button>
        }
      />
      <section className="panel posts-panel">
        <div className="posts-toolbar">
          <div className="status-tabs" aria-label="Post status">
            {statuses.map((value) => (
              <button
                key={value}
                className={status === value ? "active" : ""}
                onClick={() => updateFilter("status", value)}
                aria-pressed={status === value}
              >
                {value === "all"
                  ? "All posts"
                  : postStatusLabel(value)}
              </button>
            ))}
          </div>
          <div className="post-filters">
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="Search posts"
                placeholder="Search your posts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            <select
              aria-label="Filter by account"
              className="account-filter"
              value={accountId}
              onChange={(e) => updateFilter("accountId", e.target.value)}
            >
              <option value="">All accounts</option>
              {accounts.data?.map((account) => (
                <option key={account.id} value={account.id}>
                  @{account.username}
                  {account.status !== "connected" ? ` (${account.status})` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="list-column-labels">
          <span>Post & accounts</span>
          <span>Status</span>
        </div>
        {query.isPending ? (
          <LoadingRows count={4} />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : query.data?.length ? (
          <div className="post-list">
            {query.data.map((post) => (
              <PostRow post={post} key={post.id} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              filtered ? "No posts match this view" : "Your ideas start here"
            }
            description={
              filtered
                ? "Try another status, account, or search term."
                : "Write your first post, save a draft, or choose a moment to share it."
            }
            icon={<FileText size={26} />}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setParams({});
                    setSearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => createPost()}>
                  <Plus size={16} />
                  Create your first post
                </Button>
              )
            }
          />
        )}
        <div className="panel-bottom">
          <span>
            {query.data?.length || 0}{" "}
            {(query.data?.length || 0) === 1 ? "post" : "posts"}
          </span>
          <span>Results update automatically</span>
        </div>
      </section>
    </>
  );
}
