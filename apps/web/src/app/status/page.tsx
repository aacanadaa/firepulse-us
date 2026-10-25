import type { Metadata } from "next";
import DocPage from "@/components/DocPage";
import { getUptime, type MonitorStatus, type UptimeMonitor } from "@/lib/uptime";

export const metadata: Metadata = { title: "FirePulse status" };

/** Rebuilt at most once a minute, which also keeps UptimeRobot's rate limit far away. */
export const revalidate = 60;

const STATUS_LABEL: Record<MonitorStatus, string> = {
  up: "Operational",
  down: "Down",
  paused: "Not monitored",
  pending: "Checking",
};

function percent(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return v >= 99.995 ? "100%" : `${v.toFixed(2)}%`;
}

function duration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86_400).toFixed(1)} days`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  });
}

function Monitor({ m }: { m: UptimeMonitor }) {
  const ongoing = m.status === "down" ? m.incidents[0] : undefined;
  return (
    <section className="status-monitor">
      <div className="status-row">
        <h2>{m.name}</h2>
        <span className={`status-pill ${m.status}`}>
          <span className="status-dot" aria-hidden />
          {STATUS_LABEL[m.status]}
        </span>
      </div>
      <dl className="status-stats">
        <div>
          <dt>24 hours</dt>
          <dd>{percent(m.uptime.day)}</dd>
        </div>
        <div>
          <dt>7 days</dt>
          <dd>{percent(m.uptime.week)}</dd>
        </div>
        <div>
          <dt>30 days</dt>
          <dd>{percent(m.uptime.month)}</dd>
        </div>
        <div>
          <dt>90 days</dt>
          <dd>{percent(m.uptime.quarter)}</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd>{m.responseMs == null ? "-" : `${m.responseMs} ms`}</dd>
        </div>
      </dl>
      {m.incidents.length > 0 ? (
        <ul className="status-incidents">
          {m.incidents.map((i) => (
            <li key={i.start}>
              <span>{when(i.start)}</span>
              <span>
                {i === ongoing ? "Down since then" : `Down for ${duration(i.durationSec)}`} · {i.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="status-quiet">No outages recorded.</p>
      )}
    </section>
  );
}

export default async function Status() {
  const report = await getUptime();

  if (!report.ok) {
    return (
      <DocPage title="Status">
        <p>
          {report.reason === "unconfigured"
            ? "Uptime monitoring isn't set up on this deployment."
            : "Uptime data couldn't be loaded right now. Try again in a minute."}
        </p>
      </DocPage>
    );
  }

  const down = report.monitors.filter((m) => m.status === "down");
  return (
    <DocPage title="Status" updated={when(report.checkedAt)}>
      <p className={`status-summary ${down.length > 0 ? "down" : "up"}`}>
        {down.length === 0
          ? "All systems operational."
          : `${down.map((m) => m.name).join(" and ")} ${down.length === 1 ? "is" : "are"} down. The map may be missing new data until it recovers.`}
      </p>
      {report.monitors.map((m) => (
        <Monitor key={m.id} m={m} />
      ))}
      <p className="status-note">Checked every 5 minutes by UptimeRobot. Times are Pacific.</p>
    </DocPage>
  );
}
