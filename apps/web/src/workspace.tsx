import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Post, User } from "@threadflow/shared";
import { Composer } from "./components/Composer";
import { PostDetail } from "./components/PostDetail";
import { WorkspaceContext } from "./workspace-context";

type ComposeState = { post?: Post; date?: string } | null;
export function WorkspaceProvider({
  user,
  children,
}: {
  user: User;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [composer, setComposer] = useState<ComposeState>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== "me",
    });
  };
  return (
    <WorkspaceContext.Provider
      value={{
        user,
        createPost: (date) => setComposer({ date }),
        editPost: (post) => {
          setDetailId(null);
          setComposer({ post });
        },
        viewPost: setDetailId,
        refresh,
      }}
    >
      {children}
      {composer && (
        <Composer
          key={composer.post?.id || "new"}
          post={composer.post}
          initialDate={composer.date}
          onClose={() => setComposer(null)}
        />
      )}
      {detailId && (
        <PostDetail id={detailId} onClose={() => setDetailId(null)} />
      )}
    </WorkspaceContext.Provider>
  );
}
