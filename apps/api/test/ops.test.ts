import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SourceHealth } from "@firepulse/protocol";
import { FeedWatch } from "../src/realtime/feedWatch.js";
import { MemoryAccountStore } from "../src/accounts/memory.js";

describe("feed watch", () => {
  it("reports a feed when it breaks and when it recovers, once each", async () => {
    let status: SourceHealth["status"] = "ok";
    const posted: string[] = [];
    const watch = new FeedWatch({
      snapshot: () => [{ id: "firms", label: "NASA FIRMS", kind: "signals", intervalMs: 600_000, status, lastError: "FIRMS 503" }],
      log: pino({ level: "silent" }),
      webhookUrl: "https://hooks.example/x",
      fetch: (async (_url: string, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)).text);
        return new Response("ok");
      }) as typeof fetch,
    });
    expect(await watch.check()).toEqual([]);
    status = "error";
    expect(await watch.check()).toEqual(["FirePulse feed NASA FIRMS is failing: FIRMS 503"]);
    expect(await watch.check()).toEqual([]);
    status = "ok";
    expect(await watch.check()).toEqual(["FirePulse feed NASA FIRMS has recovered"]);
    expect(posted).toHaveLength(2);
  });
});

describe("account cleanup", () => {
  it("drops expired sessions and old alert history", async () => {
    const accounts = new MemoryAccountStore();
    const user = await accounts.createUser({ username: "jo", passwordHash: null });
    const now = Date.now();
    await accounts.createSession("old", user.id, new Date(now - 1000).toISOString(), null);
    await accounts.createSession("live", user.id, new Date(now + 60_000).toISOString(), null);
    expect(await accounts.cleanup(now, 90)).toEqual({ sessions: 1, alerts: 0 });
    expect(await accounts.sessionUser("live", now, new Date(now + 60_000).toISOString())).not.toBeNull();
  });
});
