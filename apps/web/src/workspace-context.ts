import { createContext, useContext } from "react";
import type { Post, User } from "@threadflow/shared";

export interface WorkspaceState {
  user: User;
  createPost: (date?: string) => void;
  editPost: (post: Post) => void;
  viewPost: (id: string) => void;
  refresh: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace context is missing.");
  return context;
}
