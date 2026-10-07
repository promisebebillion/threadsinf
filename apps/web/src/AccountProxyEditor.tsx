import { useId, useState } from "react";
import { Eye, EyeOff, ShieldCheck, Network } from "lucide-react";
import type { AccountProxy } from "@threadflow/shared";
import { api, messageOf } from "./api";
import { Button, ConfirmDialog } from "./ui";
import { fullDateLabel } from "./time";

function proxyStatusLabel(proxy: AccountProxy | undefined, stale: boolean): string {
  if (!proxy) return "Required";
  if (proxy.status === "failed") return "Check failed";
  if (proxy.status !== "verified") return "Not checked";
  return stale ? "Recheck needed" : "Threads reachable";
}

export function AccountProxyEditor({ username, proxy, timezone, onChange, disabled = false }: {
  username: string; proxy?: AccountProxy; timezone: string; onChange: () => Promise<unknown>; disabled?: boolean;
}) {
  const passwordId = useId();
  const [protocol, setProtocol] = useState<"http" | "socks5">(proxy?.protocol ?? "socks5");
  const [host, setHost] = useState(proxy?.host ?? "");
  const [port, setPort] = useState(String(proxy?.port ?? ""));
  const [login, setLogin] = useState(proxy?.login ?? "");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const dirty = !proxy || protocol !== proxy.protocol || host.trim() !== proxy.host || Number(port) !== proxy.port || login.trim() !== proxy.login || passwordChanged;
  const needsPassword = !proxy || host.trim() !== proxy.host || Number(port) !== proxy.port || login.trim() !== proxy.login;
  const valid = !!host.trim() && Number(port) >= 1 && Number(port) <= 65535 && !!login.trim() && (!needsPassword || !!password);
  const stale = !!proxy?.checkedAt && Date.now() - new Date(proxy.checkedAt).getTime() > 5 * 60_000;
  async function check(save: boolean) {
    setPending(true); setError("");
    try {
      if (save) {
        await api.saveProxy(username, { protocol, host: host.trim(), port: Number(port), login: login.trim(), ...(password ? { password } : {}) });
        setPasswordChanged(false);
      }
      await api.checkProxy(username);
    } catch (failure) { setError(messageOf(failure)); }
    finally { await onChange(); setPending(false); }
  }
  async function remove() {
    setPending(true); setError("");
    try {
      await api.removeProxy(username);
      setRemoving(false);
      setPassword("");
      setPasswordChanged(false);
      setPasswordVisible(false);
      await onChange();
    }
    catch (failure) { setError(messageOf(failure)); }
    finally { setPending(false); }
  }
  return <section className="account-proxy" aria-label={`Proxy for @${username}`}>
    <div className="proxy-heading"><strong><Network size={15} /> Account proxy</strong>
      <span className={`proxy-state ${proxy?.status === "verified" && !stale ? "proxy-verified" : ""}`}>
        {proxyStatusLabel(proxy, stale)}
      </span>
    </div>
    <fieldset disabled={disabled || pending} className="proxy-fields">
      <legend className="sr-only">Proxy settings for @{username}</legend>
      <label className="field proxy-protocol">Protocol<select value={protocol} onChange={(e) => setProtocol(e.target.value as "http" | "socks5")} aria-label={`Proxy protocol for @${username}`}><option value="socks5">SOCKS5</option><option value="http">HTTP / HTTPS</option></select></label>
      <label className="field">IPv4 address<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="196.17.249.41" autoComplete="off" spellCheck={false} aria-label={`Proxy IP for @${username}`} /></label>
      <label className="field">Port<input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="8000" autoComplete="off" aria-label={`Proxy port for @${username}`} /></label>
      <label className="field">Proxy login<input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Proxy login for @${username}`} /></label>
      <div className="field">
        <label htmlFor={passwordId}>Proxy password</label>
        <div className="proxy-password-input">
          <input id={passwordId} type={passwordVisible ? "text" : "password"} value={password}
            onChange={(e) => { setPassword(e.target.value); setPasswordChanged(!!e.target.value); }}
            placeholder={proxy ? "Saved" : "Password"} autoComplete="new-password" spellCheck={false}
            aria-label={`Proxy password for @${username}`} />
          <button type="button" className="proxy-password-toggle" aria-label={passwordVisible ? "Hide proxy password" : "Show proxy password"}
            aria-pressed={passwordVisible} disabled={!password} onClick={() => setPasswordVisible(!passwordVisible)}>
            {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      </div>
    </fieldset>
    <p className="field-hint">Checks the proxy IP and access to Threads. One proxy per account.{proxy && " Password saved encrypted. Leave blank to keep it."}</p>
    {proxy?.checkedAt && <div className="proxy-check-details">
      <span>Last check: {fullDateLabel(proxy.checkedAt, timezone)}</span>
      {proxy.exitIp && <span>Proxy IP <strong>{proxy.exitIp}</strong> · Backend IP {proxy.directIp}</span>}
    </div>}
    {(error || proxy?.error) && <p className="form-error" role="alert">{error || proxy?.error}</p>}
    <div className="proxy-actions">
      <Button type="button" variant="secondary" loading={pending} disabled={disabled || pending || !valid} onClick={() => void check(dirty)}><ShieldCheck size={14} />{dirty ? "Save & check proxy" : "Check proxy"}</Button>
      {proxy && <button type="button" className="disconnect-action" disabled={disabled || pending} onClick={() => setRemoving(true)}>Remove proxy</button>}
    </div>
    <ConfirmDialog open={removing} onOpenChange={setRemoving} title={`Remove proxy for @${username}?`} description="Threads login and publication will stop until you assign and verify another proxy. Your saved account session stays intact." confirmLabel="Remove proxy" onConfirm={() => void remove()} pending={pending} />
  </section>;
}
