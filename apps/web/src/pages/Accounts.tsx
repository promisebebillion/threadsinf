import { useEffect, useRef, useState, type FormEvent } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UsersRound,
} from "lucide-react";
import type {
  BrowserConnection,
  SessionVerification,
  SocialAccount,
} from "@threadflow/shared";
import { toast } from "sonner";
import { api, messageOf } from "../api";
import { AccountProxyEditor } from "../AccountProxyEditor";
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  PageHeading,
  StatusBadge,
} from "../ui";
import { dateLabel, fullDateLabel } from "../time";
import { useWorkspace } from "../workspace-context";

function connectionMessage(
  connection: BrowserConnection,
  expectedUsername: string,
) {
  if (connection.errorMessage) return connection.errorMessage;
  if (connection.status === "ready") {
    if (!connection.profile) {
      return "Your Threads account could not be identified. Do not save yet.";
    }
    if (connection.profile.username.toLowerCase() !== expectedUsername) {
      return `Threads is signed in as @${connection.profile.username}, but you requested @${expectedUsername}. Sign in to the correct profile before saving.`;
    }
    return `Detected @${connection.profile.username}. Confirm this is the Threads profile you want to save.`;
  }
  switch (connection.status) {
    case "waiting":
      return `Waiting for you to sign in to @${expectedUsername}…`;
    case "challenge":
      return "Threads requires verification. Complete the SMS code or security check in the Threads window. The session cannot be saved yet.";
    case "blocked":
      return "Threads has blocked this sign-in attempt. Resolve the notice in its window before continuing.";
    case "unknown":
      return "ThreadFlow cannot confirm which Threads profile is signed in. The session cannot be saved yet.";
    case "mismatch":
      return `The signed-in Threads profile does not match @${expectedUsername}. Sign in to the correct profile before saving.`;
    case "cancelled":
      return "The Threads window was closed. Close this dialog and connect again.";
    case "expired":
      return "This connection attempt expired. Close this dialog and connect again.";
    case "failed":
      return "Couldn’t detect your account. Close this dialog and try connecting again.";
    case "saved":
      return "Your session has been saved.";
  }
}

function verificationMessage(result: SessionVerification) {
  if (result.status === "verified" && result.profile) {
    return `Verified @${result.profile.username}. This confirms sign-in, not a successful publication.`;
  }
  if (result.errorMessage) return result.errorMessage;
  switch (result.status) {
    case "verified":
      return "The session could not identify a Threads profile.";
    case "challenge":
      return "Threads requires a security check. Reconnect and complete it before using this session.";
    case "expired":
      return "The saved session is signed out. Reconnect this account.";
    case "blocked":
      return "Threads has blocked this session. Open Threads to check its notice.";
    case "mismatch":
      return "The saved session belongs to a different Threads profile. Reconnect the correct account.";
    case "unknown":
      return "Could not confirm this session is signed in. Try verifying again.";
  }
}

function sessionMessage(account: SocialAccount, timezone: string) {
  if (account.status === "disconnected") {
    return "This saved connection has been removed.";
  }
  if (account.sessionVerificationError) return account.sessionVerificationError;
  if (account.sessionVerificationStatus === "verified" && account.sessionVerifiedAt) {
    return `Sign-in checked ${fullDateLabel(account.sessionVerifiedAt, timezone)}. A successful sign-in does not confirm a published post.`;
  }
  switch (account.sessionVerificationStatus) {
    case "verified":
      return "Session saved. Verify it before use.";
    case "challenge":
      return "Threads requires verification. Reconnect and complete the security check.";
    case "expired":
      return "This saved session is signed out. Reconnect the account.";
    case "blocked":
      return "Threads has blocked this session. Open Threads to check the notice.";
    case "mismatch":
      return "The session belongs to a different profile. Reconnect the correct account.";
    case "unknown":
      return "Session saved. Sign-in has not been verified. Verify it before use.";
  }
}

function sessionExpiryLabel(account: SocialAccount, timezone: string) {
  if (account.status !== "connected") return "Needs reconnection";
  if (account.tokenExpiresAt) {
    return `Until ${dateLabel(account.tokenExpiresAt, timezone, "MMM d, yyyy")}`;
  }
  return "Saved · verify before use";
}

export function AccountsPage() {
  const { user, refresh } = useWorkspace();
  const query = useQuery({ queryKey: ["accounts"], queryFn: api.accounts, refetchInterval: 10_000 });
  const proxies = useQuery({ queryKey: ["account-proxies"], queryFn: api.proxies, refetchInterval: 10_000 });
  const provider = useQuery({ queryKey: ["provider"], queryFn: api.provider });
  const [disconnecting, setDisconnecting] = useState<SocialAccount | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [desiredUsername, setDesiredUsername] = useState("");
  const [reconnecting, setReconnecting] = useState<SocialAccount | null>(null);
  const [confirmedUsername, setConfirmedUsername] = useState<string | null>(null);
  const [connection, setConnection] = useState<BrowserConnection | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const connectionId = useRef<string | null>(null);
  const mounted = useRef(true);
  const connectionReady =
    provider.data?.provider === "browser" && provider.data.configured;
  const connectionQuery = useQuery({
    queryKey: ["account-connection", connection?.id],
    queryFn: connection ? () => api.connection(connection.id) : skipToken,
    initialData: connection ?? undefined,
    enabled: !!connection,
    retry: 1,
    refetchInterval: (request) =>
      ["waiting", "ready", "challenge", "blocked", "unknown", "mismatch"].includes(
        request.state.data?.status ?? "",
      )
        ? 2000
        : false,
  });
  const currentConnection = connectionQuery.data ?? connection;
  const detectedUsername = currentConnection?.profile?.username ?? null;
  const expectedUsername = desiredUsername.trim().replace(/^@/, "").toLowerCase();
  const selectedProxy = proxies.data?.find((item) => item.username === expectedUsername);
  const profileMatches = detectedUsername?.toLowerCase() === expectedUsername;
  const ready = currentConnection?.status === "ready" &&
    !!detectedUsername && !connectionQuery.error;
  const canSave = ready && profileMatches && confirmedUsername === detectedUsername;
  const waiting = currentConnection?.status === "waiting";
  const finished =
    !!currentConnection &&
    !["waiting", "ready", "challenge", "blocked", "unknown", "mismatch"].includes(
      currentConnection.status,
    );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (connectionId.current) {
        void api.cancelConnection(connectionId.current).catch(() => undefined);
      }
    };
  }, []);

  function openConnect(account?: SocialAccount) {
    setDesiredUsername(account?.username ?? "");
    setReconnecting(account ?? null);
    setConnectionError("");
    setConfirmedUsername(null);
    setConnectOpen(true);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (pending || connection) return;
    if (!connectionReady) {
      toast.error("Browser connection isn’t ready. Please try again.");
      return;
    }
    setPending("connect");
    try {
      const result = reconnecting
        ? await api.reconnect(reconnecting.id)
        : await api.connect({ username: expectedUsername });
      if (!mounted.current) {
        await api.cancelConnection(result.id);
        return;
      }
      connectionId.current = result.id;
      setConnectionError("");
      setConnection(result);
    } catch (error) {
      setConnectionError(messageOf(error));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function closeConnection() {
    if (pending) return;
    if (!connection) {
      setConnectOpen(false);
      return;
    }
    setPending("cancel");
    setConnectionError("");
    try {
      if (!finished) await api.cancelConnection(connection.id);
      connectionId.current = null;
      setConnection(null);
      setConnectOpen(false);
    } catch (error) {
      setConnectionError(messageOf(error));
    } finally {
      setPending(null);
    }
  }

  async function saveConnection() {
    if (!connection || !canSave || !detectedUsername || pending) return;
    setPending("save");
    setConnectionError("");
    try {
      const account = await api.saveConnection(connection.id, {
        username: detectedUsername,
      });
      connectionId.current = null;
      setConnection(null);
      setConnectOpen(false);
      await refresh();
      toast.success(`Session saved for @${account.username}`);
    } catch (error) {
      setConnectionError(messageOf(error));
      void connectionQuery.refetch();
    } finally {
      setPending(null);
    }
  }

  async function openAccount(account: SocialAccount) {
    setPending(`open:${account.id}`);
    try {
      await api.openAccount(account.id);
      toast.success(`Opened Threads for @${account.username}`);
    } catch (error) {
      toast.error(messageOf(error));
      await refresh();
    } finally {
      setPending(null);
    }
  }

  async function verifyAccount(account: SocialAccount) {
    setPending(`verify:${account.id}`);
    try {
      const result = await api.verifyAccount(account.id);
      const verifiedProfile = result.status === "verified" &&
        result.profile?.username.toLowerCase() === account.username.toLowerCase();
      if (verifiedProfile) {
        toast.success(`Session verified for @${account.username}`);
      } else if (result.status === "verified") {
        toast.error("The session did not confirm this account. Reconnect the correct Threads profile.");
      } else {
        toast.error(verificationMessage(result));
      }
      await refresh();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    if (!disconnecting) return;
    setPending(disconnecting.id);
    try {
      await api.disconnect(disconnecting.id);
      await refresh();
      toast.success("Account disconnected");
      setDisconnecting(null);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setPending(null);
    }
  }

  const connectDisabled = !connectionReady || !!pending || connectOpen;
  return (
    <>
      <PageHeading
        title="Every account. One place."
        description="Sign in to your Threads profiles and save each session in your workspace."
        action={
          <Button
            onClick={() => openConnect()}
            loading={pending === "connect"}
            disabled={connectDisabled}
          >
            <Plus size={18} />
            Connect Threads account
          </Button>
        }
      />
      <div className="account-security-note">
        <ShieldCheck size={18} />
        <span>
          Sign in yourself in the separate Threads window. Your saved sessions
          are encrypted in Supabase. Each account needs its own proxy. We check its IP and that Threads loads; failed checks stop the operation.
        </span>
      </div>
      {provider.data && !connectionReady && (
        <section
          className="panel threads-setup"
          aria-labelledby="threads-setup-title"
        >
          <h2 id="threads-setup-title">Browser connection needs setup</h2>
          <p>
            Threads opens on the computer running ThreadFlow. Browser connection
            needs to be enabled there before you can save a session.
          </p>
          {provider.data.missing.length > 0 && (
            <p>{provider.data.missing.join(" ")}</p>
          )}
          <Button variant="secondary" onClick={() => void provider.refetch()}>
            Check again
          </Button>
        </section>
      )}
      {query.isPending ? (
        <section className="panel">
          <LoadingRows count={3} />
        </section>
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.length ? (
        <section className="panel">
          <EmptyState
            title="Connect your first Threads account"
            description="Open Threads, sign in to your account, then come back here to save the session."
            icon={<UsersRound size={29} />}
            action={
              <Button onClick={() => openConnect()} disabled={connectDisabled}>
                <Plus size={16} />
                Connect an account
              </Button>
            }
          />
        </section>
      ) : (
        <div className="accounts-grid">
          {query.data.map((account) => (
            <article
              className={`account-card ${account.status !== "connected" ? "account-inactive" : ""}`}
              key={account.id}
            >
              <div className="account-card-top">
                <Avatar account={account} size="large" />
                <span className="account-network">@</span>
              </div>
              <div className="account-card-name">
                <h2>{account.displayName}</h2>
                <p>@{account.username}</p>
                {account.provider === "browser" && account.status === "connected" ? (
                  <span className="status status-connected">
                    <span className="status-dot" />
                    Session saved
                  </span>
                ) : (
                  <StatusBadge status={account.status} />
                )}
              </div>
              <dl className="account-facts">
                <div>
                  <dt>Saved</dt>
                  <dd>{dateLabel(account.createdAt, user.timezone)}</dd>
                </div>
                <div>
                  <dt>
                    {account.provider === "browser" ? "Session" : "Authorization"}
                  </dt>
                  <dd>{sessionExpiryLabel(account, user.timezone)}</dd>
                </div>
                <div>
                  <dt>Connection</dt>
                  <dd>
                    {account.provider === "browser" ? "Browser session" : "Meta Threads"}
                  </dd>
                </div>
              </dl>
              {account.tokenExpiresAt && (
                <span className="sr-only">
                  Session expires{" "}
                  {fullDateLabel(account.tokenExpiresAt, user.timezone)}
                </span>
              )}
              {account.provider === "browser" && (
                <p className="account-session-note">
                  {sessionMessage(account, user.timezone)}
                </p>
              )}
              {account.provider === "browser" && !!proxies.data && <AccountProxyEditor
                key={account.username}
                username={account.username} proxy={proxies.data?.find((item) => item.username === account.username)} timezone={user.timezone}
                onChange={() => proxies.refetch()} disabled={!!pending || connectOpen || proxies.isPending || !!proxies.error}
              />}
              <div className="account-card-actions">
                {account.provider === "browser" &&
                  account.status === "connected" && (
                  <Button
                    variant="secondary"
                    loading={pending === `open:${account.id}`}
                    disabled={!!pending || !!connection}
                    onClick={() => void openAccount(account)}
                  >
                    <ExternalLink size={14} />
                    Open Threads
                  </Button>
                  )}
                {account.provider === "browser" && (
                  <Button
                    variant="secondary"
                    loading={pending === account.id}
                    disabled={connectDisabled}
                    onClick={() => openConnect(account)}
                  >
                    <RefreshCw size={14} />
                    Reconnect
                  </Button>
                )}
                {account.provider === "browser" &&
                  account.status !== "disconnected" && (
                  <Button
                    variant="secondary"
                    loading={pending === `verify:${account.id}`}
                    disabled={!!pending || connectOpen}
                    onClick={() => void verifyAccount(account)}
                  >
                    <ShieldCheck size={14} />
                    Verify session
                  </Button>
                  )}
                {account.status !== "disconnected" && (
                  <button
                    className="disconnect-action"
                    disabled={!!pending || !!connection}
                    onClick={() => setDisconnecting(account)}
                    aria-label={`Disconnect @${account.username}`}
                  >
                    <Unplug size={16} />
                    Disconnect
                  </button>
                )}
              </div>
            </article>
          ))}
          <button
            className="connect-account-card"
            disabled={connectDisabled}
            onClick={() => openConnect()}
          >
            <span>
              <Plus size={22} />
            </span>
            <strong>Another voice belongs here</strong>
            <p>Save another Threads session</p>
          </button>
        </div>
      )}
      {proxies.error && <ErrorState error={proxies.error} retry={() => void proxies.refetch()} />}
      {proxies.data?.filter((item) => !query.data?.some((account) => account.username === item.username)).map((proxy) => (
        <section className="panel pending-proxy" key={proxy.username}>
          <h2>Proxy saved for @{proxy.username}</h2>
          <p className="field-hint">Sign-in is not saved yet. Connect this username to continue, or remove the assignment to use the proxy elsewhere.</p>
          <AccountProxyEditor key={proxy.username} username={proxy.username} proxy={proxy} timezone={user.timezone} onChange={() => proxies.refetch()} disabled={!!pending || connectOpen} />
        </section>
      ))}
      {provider.error && (
        <ErrorState error={provider.error} retry={() => void provider.refetch()} />
      )}
      <Modal
        open={connectOpen}
        onOpenChange={(open) => {
          if (!open) void closeConnection();
        }}
        title="Sign in to Threads"
        description="Choose the exact Threads profile first. Sign in yourself, then confirm the detected account."
      >
        {!connection && (
          <form onSubmit={(event) => void connect(event)}>
            <div className="session-connect-body">
              <label className="field">
                Threads username
                <input
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={desiredUsername}
                  onChange={(event) => setDesiredUsername(event.target.value)}
                  placeholder="@your_threads_username"
                  pattern="@?[A-Za-z0-9._]{1,30}"
                  maxLength={31}
                  required
                  readOnly={!!reconnecting}
                  disabled={!!pending}
                  aria-describedby="threads-username-help"
                />
              </label>
              <p id="threads-username-help" className="field-hint">
                Use the username shown on your Threads profile. Your Instagram
                login may belong to a different linked profile. We only save the
                session when the detected Threads username matches.
              </p>
              {/^[a-z0-9._]{1,30}$/.test(expectedUsername) && !!proxies.data && <AccountProxyEditor
                key={expectedUsername}
                username={expectedUsername} proxy={selectedProxy} timezone={user.timezone}
                onChange={() => proxies.refetch()} disabled={!!pending || proxies.isPending || !!proxies.error}
              />}
              <p className="field-hint">Save the proxy first. Every sign-in checks the proxy IP and waits for the Threads login page. A failed check stops the connection.</p>
              {connectionError && (
                <p className="form-error" role="alert">
                  {connectionError}
                </p>
              )}
            </div>
            <footer className="connect-footer">
              <Button
                variant="secondary"
                type="button"
                disabled={!!pending}
                onClick={() => void closeConnection()}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={pending === "connect"}
                disabled={!expectedUsername || !selectedProxy || !!pending || proxies.isPending || !!proxies.error}
              >
                Open Threads sign-in
              </Button>
            </footer>
          </form>
        )}
        {connection && (
          <>
        <div className="session-connect-body">
          <p>
            Requested Threads profile: <strong>@{expectedUsername}</strong>
          </p>
          <ol className="session-connect-steps">
            <li>
              Sign in to the Threads profile @{expectedUsername} in the opened window.
            </li>
            <li>Complete any verification that Threads asks you for.</li>
            <li>
              Confirm the detected username here before pressing “Save session”.
            </li>
          </ol>
          <div
            className={`session-connection-status ${ready && profileMatches ? "session-ready" : ""}`}
            role="status"
            aria-live="polite"
          >
            {waiting && (
              <LoaderCircle size={20} className="spin" />
            )}
            {ready && profileMatches && (
              <CheckCircle2 size={20} />
            )}
            {!waiting && !ready && (
              <ShieldCheck size={20} />
            )}
            <p>
              {currentConnection && connectionMessage(currentConnection, expectedUsername)}
            </p>
          </div>
          {ready && profileMatches && detectedUsername && (
            <label className="session-confirmation">
              <input
                type="checkbox"
                checked={confirmedUsername === detectedUsername}
                onChange={(event) => setConfirmedUsername(
                  event.target.checked ? detectedUsername : null,
                )}
                disabled={!!pending}
              />
              <span>
                I confirm @{detectedUsername} is the Threads account I want to save.
              </span>
            </label>
          )}
          {connectionQuery.error && (
            <ErrorState
              error={connectionQuery.error}
              retry={() => void connectionQuery.refetch()}
            />
          )}
          {connectionError && (
            <p className="form-error" role="alert">
              {connectionError}
            </p>
          )}
          <p className="field-hint">
            The session stays encrypted in Supabase. You can verify the saved
            session again from its account card.
          </p>
        </div>
        <footer className="connect-footer">
          <Button
            variant="secondary"
            loading={pending === "cancel"}
            disabled={!!pending}
            onClick={() => void closeConnection()}
          >
            {finished ? "Close" : "Cancel"}
          </Button>
          <Button
            loading={pending === "save"}
            disabled={!canSave || !!pending || !!connectionQuery.error}
            onClick={() => void saveConnection()}
          >
            Save session
          </Button>
        </footer>
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={!!disconnecting}
        onOpenChange={(open) => {
          if (!open && !pending) setDisconnecting(null);
        }}
        title={`Disconnect @${disconnecting?.username || ""}?`}
        description="The saved connection will be removed. You can sign in again to reconnect this account. Your post history stays in your workspace."
        confirmLabel="Disconnect account"
        onConfirm={() => void disconnect()}
        pending={!!pending}
      />
    </>
  );
}
