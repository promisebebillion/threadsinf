import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe2, LogOut, Save, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { api, messageOf } from "../api";
import { allTimezones, fullDateLabel } from "../time";
import { Button, ConfirmDialog, PageHeading } from "../ui";
import { useWorkspace } from "../workspace-context";

export function SettingsPage() {
  const { user } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [timezone, setTimezone] = useState(user.timezone);
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await api.updateProfile({ name: name.trim(), timezone });
      queryClient.setQueryData(["me"], response);
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== "me",
      });
      toast.success("Workspace preferences saved");
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setPending(false);
    }
  }
  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout();
      queryClient.clear();
      window.location.assign("/login");
    } catch (error) {
      toast.error(messageOf(error));
      setSigningOut(false);
      setConfirm(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Make this space your own."
        description="A few simple preferences for a workspace that fits your day."
      />
      <div className="settings-layout">
        <form className="panel settings-panel" onSubmit={save}>
          <section className="settings-section">
            <div className="settings-section-title">
              <span>
                <UserRound size={19} />
              </span>
              <div>
                <h2>Your profile</h2>
                <p>The person behind the conversations.</p>
              </div>
            </div>
            <div className="settings-fields">
              <label className="field">
                Full name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  autoComplete="name"
                  disabled={pending}
                />
              </label>
              <label className="field">
                Email address
                <input
                  type="email"
                  value={user.email}
                  readOnly
                  className="readonly-field"
                />
                <small>Your sign-in email is linked to this workspace.</small>
              </label>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title">
              <span>
                <Globe2 size={19} />
              </span>
              <div>
                <h2>Your publishing timezone</h2>
                <p>Plan your posts in the time that makes sense to you.</p>
              </div>
            </div>
            <label className="field">
              Timezone
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={pending}
              >
                {Array.from(new Set([user.timezone, ...allTimezones])).map(
                  (zone) => (
                    <option value={zone} key={zone}>
                      {zone.replaceAll("_", " ")}
                    </option>
                  ),
                )}
              </select>
            </label>
            <div className="timezone-explanation">
              <Globe2 size={17} />{" "}
              <p>
                Calendar dates and publication times are shown in this timezone.
                Existing posts keep their original publication time when you
                change it.
              </p>
            </div>
          </section>
          {error && (
            <p className="form-error settings-error" role="alert">
              {error}
            </p>
          )}
          <footer className="settings-footer">
            <span>
              {name.trim() === user.name && timezone === user.timezone
                ? "Your preferences are up to date"
                : "You have unsaved changes"}
            </span>
            <Button
              type="submit"
              loading={pending}
              disabled={
                pending ||
                !name.trim() ||
                (name.trim() === user.name && timezone === user.timezone)
              }
            >
              <Save size={16} />
              Save changes
            </Button>
          </footer>
        </form>
        <aside>
          <section className="panel account-info-panel">
            <ShieldCheck size={24} />
            <h3>A workspace that’s yours.</h3>
            <p>Your content and connected accounts are visible only to you.</p>
            <dl>
              <dt>Member since</dt>
              <dd>{fullDateLabel(user.createdAt, timezone).split(" · ")[0]}</dd>
              <dt>Workspace</dt>
              <dd>Personal</dd>
            </dl>
          </section>
          <section className="settings-signout">
            <h3>All done for now?</h3>
            <p>You can come back to your workspace whenever you’re ready.</p>
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              <LogOut size={16} />
              Sign out
            </Button>
          </section>
        </aside>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out of your workspace?"
        description="Your drafts and scheduled posts are safely saved. Scheduled publications continue even when you’re away."
        confirmLabel="Sign out"
        onConfirm={() => void signOut()}
        pending={signingOut}
      />
    </>
  );
}
