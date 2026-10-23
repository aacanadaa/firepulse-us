import type { SourceHealth } from "@firepulse/protocol";
import type { Logger } from "pino";

/**
 * Tells operators when a data feed breaks or goes quiet, and when it comes
 * back: always in the log, and to a Slack/Discord-style webhook when one is
 * configured. A household app that silently stops ingesting is the worst
 * failure there is.
 */
export class FeedWatch {
  private last = new Map<string, SourceHealth["status"]>();

  constructor(
    private readonly deps: {
      snapshot: () => SourceHealth[];
      log: Logger;
      webhookUrl?: string;
      fetch?: typeof fetch;
    },
  ) {}

  /** Returns the messages sent this check. */
  async check(): Promise<string[]> {
    const messages: string[] = [];
    for (const s of this.deps.snapshot()) {
      const prev = this.last.get(s.id);
      this.last.set(s.id, s.status);
      const bad = s.status === "error" || s.status === "stale";
      const wasBad = prev === "error" || prev === "stale";
      if (bad && !wasBad) {
        const detail = s.status === "error" ? (s.lastError ?? "polling failed") : `no successful poll since ${s.lastSuccessAt ?? "start"}`;
        messages.push(`FirePulse feed ${s.label} is ${s.status === "error" ? "failing" : "stale"}: ${detail}`);
      } else if (!bad && wasBad && s.status === "ok") {
        messages.push(`FirePulse feed ${s.label} has recovered`);
      }
    }
    for (const text of messages) {
      this.deps.log.warn({ alert: text }, "feed status changed");
      if (!this.deps.webhookUrl) continue;
      try {
        // "text" for Slack, "content" for Discord.
        await (this.deps.fetch ?? fetch)(this.deps.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        this.deps.log.warn({ err }, "ops webhook failed");
      }
    }
    return messages;
  }
}
