"use client";

import { useEffect, useState } from "react";
import { ALERT_KINDS, type AlertKind } from "@firepulse/protocol";
import { accountFetch, googleSignInUrl, useAlertHistory, type Account, type PushState } from "@/lib/account";
import { formatAgeShort } from "@/lib/format";
import { Icon } from "./ui";

const KIND_LABELS: Record<AlertKind, { label: string; note: string }> = {
  evacuation: { label: "Evacuation orders", note: "Always sent right away, even in quiet hours" },
  fire_warning: { label: "Fire warnings", note: "Always sent right away, even in quiet hours" },
  new_fire: { label: "New fires nearby", note: "Official fires and confirmed satellite fires in your radius" },
  fire_closer: { label: "Fires getting closer", note: "When a fire crosses 10, 5 or 2 km, or reaches a place" },
  fire_weather: { label: "Fire weather", note: "Red flag and extreme fire danger, at most once a day" },
  spread: { label: "Spread forecasts", note: "When a fire is predicted to move toward a place" },
};

function toTime(min: number | null): string {
  if (min == null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function fromTime(v: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function SignIn({ account, error }: { account: Account; error: string | null }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      if (mode === "signup") await account.signup(username, password);
      else await account.login(username, password);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-section">
      <div className="sb-mode" role="tablist" aria-label="Sign in or create an account">
        <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
          Create account
        </button>
      </div>
      <p className="acct-lead">
        {mode === "signup"
          ? "An account keeps your places and sends alerts to this browser. No email needed."
          : "Sign in to get alerts for your places."}
      </p>
      <form onSubmit={submit} className="acct-form">
        <label>
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={mode === "signup" ? 8 : 1}
          />
        </label>
        {mode === "signup" ? (
          <p className="acct-hint">
            At least 8 characters. There&apos;s no email reset, so keep it somewhere safe. Creating an account means you
            accept the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.
          </p>
        ) : null}
        {problem ? <p className="acct-error" role="alert">{problem}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>
      {account.state?.googleEnabled ? (
        <>
          <div className="acct-or">
            <span>or</span>
          </div>
          <a className="btn acct-google" href={googleSignInUrl(typeof window === "undefined" ? "/" : window.location.pathname)}>
            <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
              <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
            </svg>
            Continue with Google
          </a>
        </>
      ) : null}
    </div>
  );
}

function DeviceAlerts({ push }: { push: PushState }) {
  const [note, setNote] = useState<string | null>(null);
  if (push.needsInstall) {
    return (
      <p className="acct-hint">
        On iPhone and iPad, alerts only work from the home screen app: tap <strong>Share</strong>, then{" "}
        <strong>Add to Home Screen</strong>, open FirePulse from there and turn alerts on.
      </p>
    );
  }
  if (!push.supported) return <p className="acct-hint">This browser can't receive alerts. Try Chrome, Edge, Firefox or Safari.</p>;
  return (
    <>
      <div className="acct-row">
        <span className={`acct-dot ${push.subscribed ? "on" : ""}`} aria-hidden />
        <span>{push.subscribed ? "Alerts are on for this device" : "Alerts are off for this device"}</span>
      </div>
      <div className="acct-actions">
        {push.subscribed ? (
          <>
            <button type="button" className="btn" disabled={push.busy} onClick={() => push.test().then(setNote).catch((e) => setNote(String(e.message)))}>
              Send a test alert
            </button>
            <button type="button" className="btn btn-ghost" disabled={push.busy} onClick={() => void push.disable()}>
              Turn off
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={push.busy} onClick={() => void push.enable()}>
            {push.busy ? "Turning on…" : "Turn on alerts"}
          </button>
        )}
      </div>
      {push.permission === "denied" ? (
        <p className="acct-error">Notifications are blocked for this site. Allow them in your browser's site settings, then try again.</p>
      ) : null}
      {push.error && push.permission !== "denied" ? <p className="acct-error">{push.error}</p> : null}
      {note ? <p className="acct-hint">{note}</p> : null}
    </>
  );
}

function Settings({ account }: { account: Account }) {
  const s = account.state!.user!.settings;
  const [kinds, setKinds] = useState<AlertKind[]>(s.alertKinds);
  const [quiet, setQuiet] = useState(s.quietStartMin != null);
  const [start, setStart] = useState(toTime(s.quietStartMin ?? 22 * 60));
  const [end, setEnd] = useState(toTime(s.quietEndMin ?? 7 * 60));
  const [saved, setSaved] = useState<string | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = async () => {
    setSaved(null);
    try {
      await account.saveSettings({
        alertKinds: kinds,
        quietStartMin: quiet ? fromTime(start) : null,
        quietEndMin: quiet ? fromTime(end) : null,
        timezone: zone,
      });
      setSaved("Saved.");
    } catch (err) {
      setSaved(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  return (
    <>
      <div className="acct-section">
        <div className="kicker">What to alert me about</div>
        {ALERT_KINDS.map((k) => (
          <label key={k} className="acct-check">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={(e) => setKinds((prev) => (e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)))}
            />
            <span>
              {KIND_LABELS[k].label}
              <small>{KIND_LABELS[k].note}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="acct-section">
        <div className="kicker">Quiet hours</div>
        <label className="acct-check">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          <span>
            Hold non-urgent alerts overnight
            <small>Evacuation orders and fire warnings still come through. Times are in {zone}.</small>
          </span>
        </label>
        {quiet ? (
          <div className="acct-times">
            <label>
              From <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              to <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
        ) : null}
        <div className="acct-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()}>
            Save alert settings
          </button>
          {saved ? <span className="acct-hint">{saved}</span> : null}
        </div>
      </div>
    </>
  );
}

function History({ signedIn, now }: { signedIn: boolean; now: number }) {
  const items = useAlertHistory(signedIn, true);
  if (items.length === 0) return <p className="acct-hint">No alerts yet. They'll appear here as well as on your devices.</p>;
  return (
    <ul className="acct-history">
      {items.slice(0, 12).map((a) => (
        <li key={a.id}>
          <a href={a.url} className={`sev-${a.severity}`}>
            <strong>{a.title}</strong>
            <span>{a.body}</span>
            <small className="mono">
              {formatAgeShort(now - Date.parse(a.createdAt))} ago ·{" "}
              {a.status === "sent" ? "delivered" : a.status === "no_device" ? "no device had alerts on" : a.status === "suppressed" ? "held back (too many this hour)" : a.status}
            </small>
          </a>
        </li>
      ))}
    </ul>
  );
}

function AccountActions({ account }: { account: Account }) {
  const user = account.state!.user!;
  const [pw, setPw] = useState({ open: false, current: "", next: "", msg: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const changePassword = async () => {
    try {
      await accountFetch("/api/v1/me/password", { method: "POST", body: { current: pw.current, next: pw.next } });
      setPw({ open: false, current: "", next: "", msg: "Password changed. Other devices are signed out." });
    } catch (err) {
      setPw((p) => ({ ...p, msg: err instanceof Error ? err.message : "Couldn't change it." }));
    }
  };

  return (
    <div className="acct-section">
      <div className="kicker">Account</div>
      <p className="acct-lead">
        Signed in as <strong>{user.username}</strong>
        {user.google ? " · Google linked" : ""}
      </p>
      <div className="acct-actions">
        {!user.google && account.state?.googleEnabled ? (
          <a className="btn" href={googleSignInUrl("/", true)}>
            Link Google
          </a>
        ) : null}
        <button type="button" className="btn" onClick={() => setPw((p) => ({ ...p, open: !p.open, msg: "" }))}>
          {user.hasPassword ? "Change password" : "Set a password"}
        </button>
        <button type="button" className="btn" onClick={() => void account.logout()}>
          Sign out
        </button>
      </div>
      {pw.open ? (
        <div className="acct-form">
          {user.hasPassword ? (
            <label>
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} />
            </label>
          ) : null}
          <label>
            <span>New password</span>
            <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} />
          </label>
          <button type="button" className="btn btn-primary" onClick={() => void changePassword()}>
            Save password
          </button>
        </div>
      ) : null}
      {pw.msg ? <p className="acct-hint">{pw.msg}</p> : null}
      <div className="acct-danger">
        {confirmDelete ? (
          <>
            <span>Delete your account, places and alert history?</span>
            <button
              type="button"
              className="btn"
              onClick={() => void accountFetch("/api/v1/me", { method: "DELETE" }).then(() => account.refresh())}
            >
              Delete
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
            Delete account
          </button>
        )}
      </div>
    </div>
  );
}

/** Sign-in, alerts on this device, alert settings and history. */
export default function AccountPanel({
  account,
  push,
  now,
  error,
  onClose,
}: {
  account: Account;
  push: PushState;
  now: number;
  error: string | null;
  onClose: () => void;
}) {
  const user = account.state?.user ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="acct-scrim" onClick={onClose} aria-hidden />
      <aside className="acct-panel thin" role="dialog" aria-label={user ? "Alerts and account" : "Sign in"}>
        <div className="acct-head">
          <div>
            <div className="kicker">{user ? "Alerts and account" : "FirePulse account"}</div>
            <h2 className="h2" style={{ marginTop: 3 }}>
              {user ? (user.displayName ?? user.username) : "Get alerts"}
            </h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ width: 24, height: 24 }}>
            <Icon name="close" size={12} />
          </button>
        </div>

        {account.unavailable ? (
          <p className="acct-section acct-error">Accounts aren't reachable right now. The map still works.</p>
        ) : !user ? (
          <SignIn account={account} error={error} />
        ) : (
          <>
            <div className="acct-section">
              <div className="kicker">Alerts on this device</div>
              <DeviceAlerts push={push} />
            </div>
            <Settings account={account} />
            <div className="acct-section">
              <div className="kicker">Recent alerts</div>
              <History signedIn now={now} />
            </div>
            <AccountActions account={account} />
          </>
        )}
        <p className="np-disclaimer">
          FirePulse alerts are not official warnings and can be late or wrong. Follow local officials and call 911 in an
          emergency.
        </p>
        <p className="np-disclaimer legal-links">
          <a href="/about">About &amp; data</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </p>
      </aside>
    </>
  );
}
