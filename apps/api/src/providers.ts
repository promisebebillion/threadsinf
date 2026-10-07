import { config } from "./config.js";
import { z } from "zod";
import type { SessionVerificationStatus } from "@threadflow/shared";

export interface ProviderAccount {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface ProviderConnection {
  account: ProviderAccount;
  accessToken: string;
  expiresAt: Date;
}
export interface PublishInput {
  accountId: string;
  accessToken: string;
  content: string;
  containerId: string | null;
  saveContainer: (id: string) => Promise<void>;
  markPublishStarted: () => Promise<void>;
}
interface ProviderFailureOptions {
  retryable?: boolean;
  authExpired?: boolean;
  uncertain?: boolean;
  sessionVerificationStatus?: SessionVerificationStatus;
}
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly authExpired: boolean;
  readonly uncertain: boolean;
  readonly sessionVerificationStatus?: SessionVerificationStatus;
  constructor(message: string, options: ProviderFailureOptions = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
    this.authExpired = options.authExpired ?? false;
    this.uncertain = options.uncertain ?? false;
    this.sessionVerificationStatus = options.sessionVerificationStatus;
  }
}

interface MetaRequest {
  path: string;
  params: Record<string, string>;
  method: "GET" | "POST";
  token?: string;
  publishing?: boolean;
  tokenEndpoint?: boolean;
}

export class MetaThreadsProvider {
  private readonly base = "https://graph.threads.com/v1.0";
  private credentials() {
    if (!config.META_APP_ID || !config.META_APP_SECRET)
      throw new ProviderError(
        "Threads connection is not configured. Set the Meta application credentials on the server.",
      );
  }
  authorizationUrl(state: string): string {
    this.credentials();
    const url = new URL("https://www.threads.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.META_APP_ID,
      redirect_uri: config.META_REDIRECT_URI,
      scope: "threads_basic,threads_content_publish",
      response_type: "code",
      state,
    }).toString();
    return url.toString();
  }
  private async request(input: MetaRequest): Promise<Record<string, unknown>> {
    const { path, params, method, token, publishing = false } = input;
    const base = input.tokenEndpoint ? "https://graph.threads.com" : this.base;
    const url = new URL(`${base}/${path}`);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const encoded = new URLSearchParams(params);
    if (method === "GET") url.search = encoded.toString();
    else headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? encoded : undefined,
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
    } catch {
      const message = publishing
        ? "Threads did not confirm publication. Verify this post on Threads before posting again."
        : "Threads is temporarily unreachable.";
      throw new ProviderError(message, {
        retryable: !publishing,
        uncertain: publishing,
      });
    }
    let data: Record<string, unknown>;
    try {
      data = z.record(z.unknown()).parse(await response.json());
    } catch {
      throw new ProviderError("Threads returned an invalid response.", {
        retryable: !publishing,
        uncertain: publishing,
      });
    }
    if (!response.ok || data.error) {
      const parsedError = z
        .object({
          code: z.number().optional(),
          error_subcode: z.number().optional(),
          is_transient: z.boolean().optional(),
        })
        .safeParse(data.error);
      const code = parsedError.success ? parsedError.data.code : undefined;
      const subcode = parsedError.success
        ? parsedError.data.error_subcode
        : undefined;
      const containerNotReady = subcode === 4279009;
      const authExpired = response.status === 401 || code === 190;
      const rateLimited =
        response.status === 429 ||
        (code !== undefined && [4, 17, 32, 613].includes(code));
      const transient =
        response.status >= 500 ||
        (parsedError.success && parsedError.data.is_transient === true) ||
        code === 1 ||
        code === 2;
      const retryable =
        !authExpired && (containerNotReady || rateLimited || (!publishing && transient));
      const uncertain = publishing && transient && !containerNotReady;
      // Never return or log raw provider payloads: they can contain credentials.
      let message = `Threads rejected the request (HTTP ${response.status}).`;
      if (uncertain)
        message =
          "Threads did not confirm publication. Verify this post on Threads before posting again.";
      if (authExpired)
        message = "Threads authorization expired. Reconnect this account.";
      else if (containerNotReady)
        message =
          "Threads has not made the publication container available yet. Publication will retry shortly.";
      else if (rateLimited)
        message = "Threads request limit reached. Publication will retry later.";
      else if (code === 10 || code === 200)
        message =
          "Threads publishing permission is missing. Grant threads_content_publish and reconnect this account. In development mode, add this profile as a Threads tester in your Meta app.";
      else if (code === 100)
        message =
          "Threads rejected the request parameters. Check the text and the Meta app callback settings.";
      throw new ProviderError(message, { retryable, authExpired, uncertain });
    }
    return data;
  }
  async connectAccount(code: string): Promise<ProviderConnection> {
    this.credentials();
    const short = await this.request({
      path: "oauth/access_token",
      params: {
        client_id: config.META_APP_ID,
        client_secret: config.META_APP_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.META_REDIRECT_URI,
      },
      method: "POST",
      tokenEndpoint: true,
    });
    if (typeof short.access_token !== "string" || !short.access_token)
      throw new ProviderError("Threads did not return an access token.");
    const long = await this.request({
      path: "access_token",
      params: {
        grant_type: "th_exchange_token",
        client_secret: config.META_APP_SECRET,
        access_token: short.access_token,
      },
      method: "GET",
      tokenEndpoint: true,
    });
    if (
      typeof long.access_token !== "string" ||
      !long.access_token ||
      typeof long.expires_in !== "number" ||
      !Number.isFinite(long.expires_in) ||
      long.expires_in <= 0
    )
      throw new ProviderError("Threads did not return a long-lived token.");
    const account = await this.getAccountInfo(long.access_token);
    return {
      account,
      accessToken: long.access_token,
      expiresAt: new Date(Date.now() + long.expires_in * 1000),
    };
  }
  async connectWithToken(accessToken: string): Promise<ProviderConnection> {
    const result = await this.request({
      path: "debug_token",
      params: { input_token: accessToken },
      method: "GET",
      token: accessToken,
    });
    const inspected = z
      .object({
        is_valid: z.literal(true),
        app_id: z.string().optional(),
        user_id: z.string().optional(),
        scopes: z.array(z.string()),
        expires_at: z.number().finite().positive(),
      })
      .safeParse(result.data);
    if (!inspected.success || inspected.data.expires_at * 1000 <= Date.now())
      throw new ProviderError(
        "This Threads token is invalid or expired. Generate a new Threads user access token in your Meta app.",
      );
    if (
      !inspected.data.scopes.includes("threads_basic") ||
      !inspected.data.scopes.includes("threads_content_publish")
    )
      throw new ProviderError(
        "The Threads token needs threads_basic and threads_content_publish permissions. Generate it with both permissions enabled.",
      );
    if (config.META_APP_ID && inspected.data.app_id !== config.META_APP_ID)
      throw new ProviderError(
        "This Threads token belongs to a different Meta app. Generate it from the Threads app configured on this server.",
      );
    const account = await this.getAccountInfo(accessToken);
    if (inspected.data.user_id && inspected.data.user_id !== account.id)
      throw new ProviderError(
        "Threads could not verify this token's account. Generate a new user access token.",
      );
    return {
      account,
      accessToken,
      expiresAt: new Date(inspected.data.expires_at * 1000),
    };
  }
  async getAccountInfo(accessToken: string): Promise<ProviderAccount> {
    const account = await this.request({
      path: "me",
      params: { fields: "id,username,name,threads_profile_picture_url" },
      method: "GET",
      token: accessToken,
    });
    if (typeof account.id !== "string" || typeof account.username !== "string")
      throw new ProviderError("Threads did not return an account profile.");
    return {
      id: account.id,
      username: account.username,
      displayName:
        typeof account.name === "string" ? account.name : account.username,
      avatarUrl:
        typeof account.threads_profile_picture_url === "string" &&
        account.threads_profile_picture_url.startsWith("https://")
          ? account.threads_profile_picture_url
          : null,
    };
  }
  async refreshToken(accessToken: string) {
    const token = await this.request({
      path: "refresh_access_token",
      params: { grant_type: "th_refresh_token", access_token: accessToken },
      method: "GET",
      tokenEndpoint: true,
    });
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    )
      throw new ProviderError(
        "Threads could not refresh this token. Reconnect the account.",
      );
    return {
      accessToken: token.access_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    };
  }
  async publishPost(input: PublishInput) {
    let containerId = input.containerId;
    if (!containerId) {
      const container = await this.request({
        path: `${input.accountId}/threads`,
        params: { media_type: "TEXT", text: input.content },
        method: "POST",
        token: input.accessToken,
      });
      if (typeof container.id !== "string")
        throw new ProviderError(
          "Threads did not return a publication container.",
        );
      containerId = container.id;
      await input.saveContainer(containerId);
    }
    let ready = false;
    for (let check = 0; check < 10; check++) {
      const container = await this.request({
        path: containerId,
        params: { fields: "status,error_message" },
        method: "GET",
        token: input.accessToken,
      });
      if (container.status === "FINISHED") {
        ready = true;
        break;
      }
      if (container.status === "PUBLISHED")
        throw new ProviderError(
          "This Threads container is already published. Verify it on Threads before posting again.",
          { uncertain: true },
        );
      if (container.status === "ERROR" || container.status === "EXPIRED")
        throw new ProviderError(
          "Threads could not prepare this post. Create a new post after reviewing the text.",
        );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!ready)
      throw new ProviderError("Threads is still preparing this post.", {
        retryable: true,
      });
    // Persist this boundary before an irreversible request. Crash recovery will never blindly repeat it.
    await input.markPublishStarted();
    const published = await this.request({
      path: `${input.accountId}/threads_publish`,
      params: { creation_id: containerId },
      method: "POST",
      token: input.accessToken,
      publishing: true,
    });
    if (typeof published.id !== "string")
      throw new ProviderError(
        "Threads did not confirm a publication ID. Verify it on Threads before posting again.",
        { uncertain: true },
      );
    return { externalPostId: published.id };
  }
}

export const metaProvider = new MetaThreadsProvider();
