/**
 * UptimeRobot monitors for this site, read on the server only: the key is
 * account-wide, so it never reaches the browser and other monitors on the
 * account are filtered out.
 */

const ENDPOINT = "https://api.uptimerobot.com/v2/getMonitors";

/** Monitors whose URL contains this belong to FirePulse. */
const MATCH = "firepulse";

export type MonitorStatus = "up" | "down" | "paused" | "pending";

export interface UptimeIncident {
  /** epoch ms */
  start: number;
  /** seconds; still ongoing when it is the latest event and the monitor is down */
  durationSec: number;
  reason: string;
}

export interface UptimeMonitor {
  id: number;
  name: string;
  status: MonitorStatus;
  /** percent over 1, 7, 30 and 90 days */
  uptime: { day: number; week: number; month: number; quarter: number };
  responseMs: number | null;
  incidents: UptimeIncident[];
}

export type UptimeReport =
  | { ok: true; checkedAt: number; monitors: UptimeMonitor[] }
  | { ok: false; reason: "unconfigured" | "unavailable" };

interface RawMonitor {
  id: number;
  url: string;
  status: number;
  custom_uptime_ratio?: string;
  average_response_time?: string;
  logs?: { type: number; datetime: number; duration: number; reason?: { code?: string; detail?: string } }[];
}

function statusOf(code: number): MonitorStatus {
  if (code === 2) return "up";
  if (code === 8 || code === 9) return "down";
  if (code === 0) return "paused";
  return "pending";
}

function nameOf(url: string): string {
  return /\/api\//.test(url) ? "Live data API" : "Website";
}

export async function getUptime(): Promise<UptimeReport> {
  const key = process.env.UPTIMEROBOT_API_KEY;
  if (!key) return { ok: false, reason: "unconfigured" };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: key,
        format: "json",
        custom_uptime_ratios: "1-7-30-90",
        response_times: "1",
        response_times_limit: "1",
        logs: "1",
        logs_limit: "20",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const json = (await res.json()) as { stat?: string; monitors?: RawMonitor[] };
    if (json.stat !== "ok" || !Array.isArray(json.monitors)) return { ok: false, reason: "unavailable" };

    const monitors = json.monitors
      .filter((m) => m.url.toLowerCase().includes(MATCH))
      .map((m): UptimeMonitor => {
        const [day, week, month, quarter] = (m.custom_uptime_ratio ?? "")
          .split("-")
          .map((v) => Number(v));
        const response = Number(m.average_response_time);
        return {
          id: m.id,
          name: nameOf(m.url),
          status: statusOf(m.status),
          uptime: { day: day ?? NaN, week: week ?? NaN, month: month ?? NaN, quarter: quarter ?? NaN },
          responseMs: Number.isFinite(response) && response > 0 ? Math.round(response) : null,
          // Log type 1 is a down event; its duration is how long the outage lasted.
          incidents: (m.logs ?? [])
            .filter((l) => l.type === 1)
            .slice(0, 5)
            .map((l) => ({
              start: l.datetime * 1000,
              durationSec: l.duration,
              reason: [l.reason?.code, l.reason?.detail].filter(Boolean).join(" ") || "Unreachable",
            })),
        };
      })
      .sort((a, b) => Number(a.name !== "Website") - Number(b.name !== "Website"));

    return { ok: true, checkedAt: Date.now(), monitors };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
