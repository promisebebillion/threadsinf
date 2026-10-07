import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarDays,
  Eye,
  EyeOff,
  Layers3,
  LoaderCircle,
} from "lucide-react";
import { api, messageOf } from "../api";
import { browserTimezone } from "../time";
import { Button, Wordmark } from "../ui";

export function AuthPage({ register = false }: { register?: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      if (register && new TextEncoder().encode(password).length > 72) {
        throw new Error(
          "Password is too long. Use no more than 72 bytes (emoji and some letters use more than one byte).",
        );
      }
      const response = register
        ? await api.register({
            name: name.trim(),
            email: email.trim(),
            password,
            timezone: browserTimezone,
          })
        : await api.login({ email: email.trim(), password });
      queryClient.setQueryData(["me"], response);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Wordmark light />
        <div className="auth-story-content">
          <span className="auth-story-icon">
            <Layers3 size={28} />
          </span>
          <h1>
            Make room for
            <br />
            your next idea.
          </h1>
          <p>
            One calm workspace for your Threads accounts. Write once, find the
            right moment, and let your content flow.
          </p>
          <div className="auth-preview">
            <div className="auth-preview-top">
              <CalendarDays size={18} />
              <span>Your real Threads profiles, together</span>
            </div>
            <p>
              Sign in to Threads yourself and save each account’s session in your
              workspace.
            </p>
          </div>
        </div>
        <p className="auth-story-footer">Less switching. More sharing.</p>
      </section>
      <section className="auth-form-panel">
        <div className="auth-mobile-brand">
          <Wordmark />
        </div>
        <div className="auth-form-inner">
          <div className="auth-form-heading">
            <h2>{register ? "Your ideas belong here." : "Welcome back."}</h2>
            <p>
              {register
                ? "Create your workspace and get your content moving."
                : "Pick up where you left off. Your workspace is ready."}
            </p>
          </div>
          <form onSubmit={submit} className="auth-form">
            {register && (
              <label className="field">
                Your name
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  maxLength={80}
                />
              </label>
            )}
            <label className="field">
              Email address
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </label>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <span className="password-field">
                <input
                  id="auth-password"
                  type={visible ? "text" : "password"}
                  autoComplete={register ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    register ? "At least 10 characters" : "Enter your password"
                  }
                  required
                  minLength={register ? 10 : 1}
                  maxLength={72}
                  aria-describedby={register ? "password-help" : undefined}
                />
                <button
                  type="button"
                  aria-label={visible ? "Hide password" : "Show password"}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
              {register && (
                <small id="password-help">
                  Use at least 10 characters with a mix of letters and numbers.
                </small>
              )}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" loading={pending} className="auth-submit">
              {register ? "Create workspace" : "Sign in"}
              {!pending && <ArrowRight size={17} />}
            </Button>
          </form>
          <p className="auth-switch">
            {register ? "Already have a workspace?" : "New to ThreadFlow?"}{" "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "Sign in" : "Create an account"}
            </Link>
          </p>
          <p className="auth-trust">
            Your Threads passwords stay with Threads.
            <br />
            Sign in directly in the separate Threads window.
          </p>
        </div>
      </section>
    </main>
  );
}

export function AuthLoading() {
  return (
    <div className="auth-loading">
      <Wordmark />
      <LoaderCircle size={24} className="spin" />
      <p>Opening your workspace…</p>
    </div>
  );
}
