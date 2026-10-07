import type {
  AuthResponse,
  AccountProxy,
  ProxyInput,
  BrowserConnection,
  Dashboard,
  Post,
  PostInput,
  ProviderInfo,
  SocialAccount,
  SessionVerification,
  User,
} from "@threadflow/shared";

const apiUrl = new URL(
  import.meta.env.VITE_API_URL || "http://localhost:3000",
  window.location.origin,
);
if (import.meta.env.DEV) {
  if (window.location.hostname === "127.0.0.1") {
    const frontendUrl = new URL(window.location.href);
    frontendUrl.hostname = "localhost";
    window.location.replace(frontendUrl.href);
  }
  if (apiUrl.hostname === "127.0.0.1") apiUrl.hostname = "localhost";
}
const baseUrl = apiUrl.href.replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-threadflow-client": "web",
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Cannot reach ThreadFlow. Check that the server is running and try again.",
      0,
    );
  }
  const data =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data?.error || `Request failed (${response.status}). Please try again.`,
      response.status,
    );
  return data as T;
}

const send = <T>(path: string, body?: unknown, method = "POST") =>
  request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const api = {
  me: () => request<AuthResponse>("/auth/me"),
  login: (body: { email: string; password: string }) =>
    send<AuthResponse>("/auth/login", body),
  register: (body: {
    name: string;
    email: string;
    password: string;
    timezone: string;
  }) => send<AuthResponse>("/auth/register", body),
  logout: () => send<void>("/auth/logout"),
  updateProfile: (body: Pick<User, "name" | "timezone">) =>
    send<AuthResponse>("/auth/me", body, "PATCH"),
  accounts: () => request<SocialAccount[]>("/accounts"),
  proxies: () => request<AccountProxy[]>("/accounts/proxies"),
  saveProxy: (username: string, body: ProxyInput) => send<AccountProxy>(`/accounts/proxies/${encodeURIComponent(username)}`, body, "PUT"),
  checkProxy: (username: string) => send<AccountProxy>(`/accounts/proxies/${encodeURIComponent(username)}/check`),
  removeProxy: (username: string) => send<void>(`/accounts/proxies/${encodeURIComponent(username)}`, undefined, "DELETE"),
  provider: () => request<ProviderInfo>("/accounts/provider"),
  connect: (body: { username: string }) =>
    send<BrowserConnection>("/accounts/connect", body),
  connection: (id: string) =>
    request<BrowserConnection>(`/accounts/connections/${id}`),
  saveConnection: async (id: string, body: { username: string }) => {
    const result = await send<BrowserConnection>(`/accounts/connections/${id}/save`, body);
    if (result.status !== "saved" || !result.account)
      throw new ApiError("Threads did not confirm a saved session. Check the login window and try again.", 502);
    return result.account;
  },
  cancelConnection: (id: string) =>
    send<void>(`/accounts/connections/${id}/cancel`),
  reconnect: (id: string) =>
    send<BrowserConnection>(`/accounts/${id}/reconnect`),
  openAccount: (id: string) =>
    send<{ status: "opened" }>(`/accounts/${id}/open`),
  verifyAccount: (id: string) =>
    send<SessionVerification>(`/accounts/${id}/verify`),
  disconnect: (id: string) =>
    send<void>(`/accounts/${id}`, undefined, "DELETE"),
  dashboard: () => request<Dashboard>("/dashboard"),
  posts: (
    filters: { status?: string; accountId?: string; search?: string } = {},
  ) => {
    const search = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value),
    );
    return request<Post[]>(`/posts?${search}`);
  },
  post: (id: string) => request<Post>(`/posts/${id}`),
  createPost: (body: PostInput) => send<Post>("/posts", body),
  updatePost: (id: string, body: PostInput) =>
    send<Post>(`/posts/${id}`, body, "PATCH"),
  publishNow: (id: string) => send<Post>(`/posts/${id}/publish-now`),
  reschedule: (id: string, scheduledAt: string, timezone: string) =>
    send<Post>(`/posts/${id}/reschedule`, { scheduledAt, timezone }),
  cancelPost: (id: string) => send<void>(`/posts/${id}`, undefined, "DELETE"),
  calendar: (start: string, end: string) =>
    request<Post[]>(`/calendar?${new URLSearchParams({ start, end })}`),
};

export const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";

