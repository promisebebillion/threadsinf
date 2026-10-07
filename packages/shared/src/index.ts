export type PostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "unconfirmed"
  | "failed"
  | "cancelled";
export type AccountStatus = "connected" | "disconnected" | "expired";
export type AccountProvider = "browser" | "meta";
export interface ProxyInput {
  protocol?: "http" | "socks5";
  host: string;
  port: number;
  login: string;
  password?: string;
}
export interface AccountProxy {
  protocol: "http" | "socks5";
  username: string;
  host: string;
  port: number;
  login: string;
  hasPassword: boolean;
  status: "unchecked" | "verified" | "failed";
  checkedAt: string | null;
  directIp: string | null;
  exitIp: string | null;
  error: string | null;
}
export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string;
  createdAt: string;
}
export interface SocialAccount {
  id: string;
  provider: AccountProvider;
  providerAccountId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: AccountStatus;
  tokenExpiresAt: string | null;
  createdAt: string;
  sessionVerifiedAt: string | null;
  sessionVerificationStatus: SessionVerificationStatus;
  sessionVerificationError: string | null;
}
export interface PostTarget {
  id: string;
  socialAccountId: string;
  account: SocialAccount;
  status: PostStatus;
  externalPostId: string | null;
  publishedAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  errorMessage: string | null;
  publishUncertain: boolean;
}
export interface Post {
  id: string;
  content: string;
  status: PostStatus;
  scheduledAt: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  targets: PostTarget[];
}
export interface PostInput {
  content: string;
  accountIds: string[];
  status: "draft" | "scheduled";
  scheduledAt?: string | null;
  timezone: string;
}
export interface Dashboard {
  connectedAccounts: number;
  scheduledPosts: number;
  publishedPosts: number;
  failedPosts: number;
  upcomingPosts: Post[];
  recentPosts: Post[];
}
export interface AuthResponse {
  user: User;
}
export interface MetaProviderInfo {
  provider: "meta";
  configured: boolean;
  redirectUri: string;
  missing: string[];
}
export interface BrowserProviderInfo {
  provider: "browser";
  configured: boolean;
  missing: string[];
  loginUrl: string;
}
export type ProviderInfo = MetaProviderInfo | BrowserProviderInfo;
export interface BrowserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface BrowserConnection {
  id: string;
  status: "waiting" | "ready" | "saved" | "cancelled" | "expired" | "failed" | "challenge" | "blocked" | "unknown" | "mismatch";
  expiresAt: string;
  expectedUsername: string;
  profile?: BrowserProfile;
  account?: SocialAccount;
  errorMessage?: string;
}
export type SessionVerificationStatus = "verified" | "challenge" | "expired" | "blocked" | "unknown" | "mismatch";
export interface SessionVerification {
  status: SessionVerificationStatus;
  checkedAt: string;
  profile?: BrowserProfile;
  errorMessage?: string;
}
export interface ApiError {
  error: string;
  details?: unknown;
}
export const POST_CHARACTER_LIMIT = 500;
