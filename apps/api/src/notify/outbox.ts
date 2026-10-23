import { createHash } from "node:crypto";
import type { PushPayload } from "@firepulse/protocol";
import type { Logger } from "pino";
import type { AccountStore, AlertRecord, PushSubscriptionRecord } from "../accounts/types.js";

/** Non-urgent alerts a person gets per hour; the rest are held back. */
export const HOURLY_CAP = 6;
const MAX_ATTEMPTS = 5;
const BATCH = 50;

export interface PushSender {
  /** Resolves on success; rejects with `statusCode` on an HTTP error. */
  send(sub: PushSubscriptionRecord, payload: string, opts: { ttlSec: number; urgency: "high" | "normal" | "low"; topic: string }): Promise<void>;
}

export function pushPayload(a: Pick<AlertRecord, "title" | "body" | "url" | "severity" | "placeId" | "subjectId" | "kind">): PushPayload {
  return {
    title: a.title,
    body: a.body,
    url: a.url,
    // Newer news about the same fire at the same place replaces the old notification.
    tag: `${a.placeId}:${a.kind === "fire_weather" ? a.kind : a.subjectId}`,
    severity: a.severity,
  };
}

/**
 * Sends queued alerts to every browser a person has subscribed. Gone
 * subscriptions (404/410) are deleted; other failures retry with backoff.
 */
export class PushOutbox {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;

  constructor(
    private readonly deps: {
      accounts: AccountStore;
      sender: PushSender;
      log: Logger;
      intervalMs?: number;
      now?: () => number;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.deps.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends everything due; safe to call often. */
  async flush(): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;
    let sent = 0;
    try {
      do {
        this.again = false;
        const now = this.deps.now?.() ?? Date.now();
        const due = await this.deps.accounts.dueAlerts(new Date(now).toISOString(), BATCH);
        for (const alert of due) {
          if (await this.deliver(alert, now)) sent++;
        }
        if (due.length === BATCH) this.again = true;
      } while (this.again);
    } catch (err) {
      this.deps.log.warn({ err }, "push outbox flush failed");
    } finally {
      this.running = false;
    }
    return sent;
  }

  private async deliver(alert: AlertRecord, now: number): Promise<boolean> {
    const { accounts, sender, log } = this.deps;
    if (alert.severity !== "urgent") {
      const recent = await accounts.sentCountSince(alert.userId, new Date(now - 3_600_000).toISOString());
      if (recent >= HOURLY_CAP) {
        await accounts.markAlert(alert.id, { status: "suppressed", error: "hourly cap" });
        return false;
      }
    }

    const subs = await accounts.subscriptions(alert.userId);
    if (subs.length === 0) {
      await accounts.markAlert(alert.id, { status: "no_device" });
      return false;
    }

    const payload = JSON.stringify(pushPayload(alert));
    const opts = {
      ttlSec: alert.severity === "urgent" ? 6 * 3600 : 24 * 3600,
      urgency: alert.severity === "urgent" ? ("high" as const) : alert.severity === "warning" ? ("normal" as const) : ("low" as const),
      topic: createHash("sha256").update(pushPayload(alert).tag).digest("base64url").slice(0, 32),
    };
    let delivered = 0;
    let retryable = 0;
    let lastError = "";
    for (const sub of subs) {
      try {
        await sender.send(sub, payload, opts);
        await accounts.markSubscription(sub.endpoint, true);
        delivered++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        lastError = `${status ?? ""} ${(err as Error).message ?? err}`.trim().slice(0, 200);
        if (status === 404 || status === 410) {
          // The browser unsubscribed or the subscription expired.
          await accounts.deleteSubscription(sub.endpoint);
        } else {
          await accounts.markSubscription(sub.endpoint, false);
          retryable++;
        }
      }
    }

    if (delivered > 0) {
      await accounts.markAlert(alert.id, { status: "sent" });
      log.info({ alert: alert.id, kind: alert.kind, devices: delivered }, "alert sent");
      return true;
    }
    if (retryable > 0 && alert.attempts + 1 < MAX_ATTEMPTS) {
      const retryAt = new Date(now + 60_000 * 2 ** alert.attempts).toISOString();
      await accounts.markAlert(alert.id, { status: "pending", error: lastError, retryAt });
      return false;
    }
    await accounts.markAlert(alert.id, { status: retryable > 0 ? "failed" : "no_device", error: lastError });
    log.warn({ alert: alert.id, error: lastError }, "alert not delivered");
    return false;
  }
}

/** The real sender, backed by the web-push library and this server's VAPID keys. */
export async function webPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): Promise<PushSender> {
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(sub, payload, opts) {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: opts.ttlSec, urgency: opts.urgency, topic: opts.topic },
      );
    },
  };
}
