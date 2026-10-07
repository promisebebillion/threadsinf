import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { AuthPage, AuthLoading } from "./pages/Auth";
import { AppLayout } from "./components/AppLayout";
import { DashboardPage } from "./pages/Dashboard";
import { PostsPage } from "./pages/Posts";
import { AccountsPage } from "./pages/Accounts";
import { SettingsPage } from "./pages/Settings";
import { ErrorState, LoadingRows } from "./ui";
import { WorkspaceProvider } from "./workspace";

const CalendarPage = lazy(() =>
  import("./pages/Calendar").then((module) => ({
    default: module.CalendarPage,
  })),
);

export function App() {
  const session = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 1,
  });
  if (session.isPending) return <AuthLoading />;
  if (
    session.error &&
    !(session.error instanceof ApiError && session.error.status === 401)
  )
    return (
      <main className="connection-error">
        <ErrorState
          error={session.error}
          retry={() => void session.refetch()}
        />
      </main>
    );
  if (!session.data)
    return (
      <Routes>
        <Route path="/register" element={<AuthPage register />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  return (
    <WorkspaceProvider user={session.data.user}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route
            path="/calendar"
            element={
              <Suspense fallback={<LoadingRows />}>
                <CalendarPage />
              </Suspense>
            }
          />
          <Route path="/posts" element={<PostsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </WorkspaceProvider>
  );
}
