import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import pino from "pino";
import { circleRing, type IncidentFeature } from "@firepulse/protocol";
import {
  hashPassword,
  LoginThrottle,
  normalizeUsername,
  parseGoogleIdToken,
  passwordProblem,
  readCookie,
  safeReturnPath,
  usernameFromEmail,
  verifyPassword,
} from "../src/accounts/auth.js";
import { MemoryAccountStore } from "../src/accounts/memory.js";
import { registerAccountRoutes } from "../src/accounts/routes.js";
import { AlertEngine } from "../src/notify/engine.js";
import type { AppConfig } from "../src/config.js";

const log = pino({ level: "silent" });

describe("passwords and usernames", () => {
  it("hashes with a salt and verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batter", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("normalizes usernames and rejects weak passwords", () => {
    expect(normalizeUsername("  Jane.Doe ")).toBe("jane.doe");
    expect(normalizeUsername("ab")).toBeNull();
    expect(normalizeUsername("no spaces")).toBeNull();
    expect(passwordProblem("short", "jane")).toMatch(/at least/);
    expect(passwordProblem("jane12345", "jane")).toMatch(/username/);
    expect(passwordProblem("password123", "jane")).toMatch(/easy/);
    expect(passwordProblem("a sensible passphrase", "jane")).toBeNull();
  });

  it("derives a username from a Google email", () => {
    expect(usernameFromEmail("Jane.Doe+fire@gmail.com", "123")).toBe("jane.doefire");
    expect(usernameFromEmail("x@y.z", "abc123456789")).toBe("userabc12345");
  });

  it("reads cookies and only returns to same-site paths", () => {
    expect(readCookie("a=1; fp_session=tok%3D; b=2", "fp_session")).toBe("tok=");
    expect(safeReturnPath("/?place=1")).toBe("/?place=1");
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
  });

  it("throttles repeated failures in a window", () => {
    const t = new LoginThrottle(3, 60_000);
    for (let i = 0; i < 3; i++) t.fail("ip", 1000);
    expect(t.blocked("ip", 2000)).toBe(true);
    expect(t.blocked("ip", 62_000)).toBe(false);
  });
});

describe("Google ID tokens", () => {
  const token = (claims: Record<string, unknown>) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const now = Date.parse("2026-10-23T12:00:00Z");
  const good = { iss: "https://accounts.google.com", aud: "client", sub: "42", email: "a@b.c", email_verified: true, exp: now / 1000 + 600 };

  it("accepts a token for this client and reads the identity", () => {
    expect(parseGoogleIdToken(token(good), "client", now)).toEqual({ sub: "42", email: "a@b.c", emailVerified: true, name: null });
  });

  it("rejects the wrong audience, issuer or an expired token", () => {
    expect(() => parseGoogleIdToken(token({ ...good, aud: "other" }), "client", now)).toThrow(/audience/);
    expect(() => parseGoogleIdToken(token({ ...good, iss: "https://evil" }), "client", now)).toThrow(/issuer/);
    expect(() => parseGoogleIdToken(token({ ...good, exp: now / 1000 - 3600 }), "client", now)).toThrow(/expired/);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP routes                                                          */
/* ------------------------------------------------------------------ */

const cfg = {
  port: 8790,
  webOrigin: "http://localhost:3000",
  auth: { google: null, secret: "test-secret", secureCookies: false },
  push: { publicKey: "pub", privateKey: "", subject: "mailto:x@y.z" },
} as unknown as AppConfig;

async function server() {
  const accounts = new MemoryAccountStore();
  const fire: IncidentFeature = {
    type: "Feature",
    id: "wfigs-1",
    geometry: { type: "Polygon", coordinates: [circleRing({ lon: -121.6, lat: 39.8 }, 1, 24)] },
    properties: {
      id: "wfigs-1",
      kind: "official",
      name: "Camp",
      status: "holding",
      confidence: 100,
      confidenceBreakdown: { score: 100, fused: 1, corroboration: 1, freshness: 1, distinctModalities: 1, evidenceCount: 1, rationale: "" },
      sources: [],
      firstDetectedAt: "2026-10-23T08:00:00Z",
      updatedAt: "2026-10-23T09:00:00Z",
      officialSince: "2026-10-23T08:30:00Z",
      areaAcres: 700,
      areaSqKm: 3,
      frp: 0,
      growthAcresPerHour: 0,
      growthFrpPerHour: 0,
      growthScore: 0,
      hotspotCount: 0,
      evidence: [],
      lat: 39.8,
      lon: -121.6,
    },
  };
  const alerts = new AlertEngine({ accounts, log, incidents: () => [fire], hazards: () => [] });
  const app = Fastify();
  await registerAccountRoutes(app, { config: cfg, accounts, alerts, sender: null, log });
  return { app, accounts, alerts, fire };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(";")[0]!;
}

const json = { "content-type": "application/json", origin: "http://localhost:3000" };

describe("account routes", () => {
  it("signs up, keeps the session, saves places with a silent baseline, and signs out", async () => {
    const { app, accounts } = await server();
    const signup = await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: { username: "Jane", password: "a sensible passphrase" } });
    expect(signup.statusCode).toBe(200);
    const cookie = cookieOf(signup);
    expect(signup.headers["set-cookie"]).toMatch(/HttpOnly; SameSite=Lax/);

    const me = await app.inject({ url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.json().user.username).toBe("jane");
    expect(me.json().pushPublicKey).toBe("pub");

    const place = await app.inject({
      method: "POST",
      url: "/api/v1/me/places",
      headers: { ...json, cookie },
      payload: { name: "Paradise", lat: 39.76, lon: -121.62, radiusKm: 25 },
    });
    expect(place.statusCode).toBe(200);
    // The fire already burning nearby is known, not alerted.
    const user = (await accounts.userByUsername("jane"))!;
    expect(await accounts.recentAlerts(user.id, 10)).toHaveLength(0);
    expect(await accounts.dueAlerts(new Date().toISOString(), 10)).toHaveLength(0);

    const settings = await app.inject({
      method: "PUT",
      url: "/api/v1/me/settings",
      headers: { ...json, cookie },
      payload: { quietStartMin: 22 * 60, quietEndMin: 7 * 60, timezone: "America/Denver", alertKinds: ["evacuation", "new_fire"] },
    });
    expect(settings.json()).toEqual({ alertKinds: ["evacuation", "new_fire"], quietStartMin: 1320, quietEndMin: 420, timezone: "America/Denver" });

    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { ...json, cookie }, payload: {} });
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).json().user).toBeNull();
  });

  it("refuses duplicate usernames, wrong passwords and too many attempts", async () => {
    const { app } = await server();
    const body = { username: "sam", password: "another fine passphrase" };
    await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: body });
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: json, payload: body })).statusCode).toBe(200);
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: json, payload: { ...body, password: "nope nope nope" } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("rejects cross-site and non-JSON changes", async () => {
    const { app } = await server();
    const evil = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      payload: { username: "mallory", password: "a sensible passphrase" },
    });
    expect(evil.statusCode).toBe(403);
    const form = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=a&password=b",
    });
    expect(form.statusCode).toBe(415);
    expect((await app.inject({ url: "/api/v1/me/places" })).statusCode).toBe(401);
  });

  it("limits places and validates them", async () => {
    const { app } = await server();
    const cookie = cookieOf(
      await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: { username: "kim", password: "a sensible passphrase" } }),
    );
    const add = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/me/places", headers: { ...json, cookie }, payload });
    expect((await add({ name: "", lat: 1, lon: 1 })).statusCode).toBe(400);
    expect((await add({ name: "x", lat: 95, lon: 1 })).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) expect((await add({ name: `p${i}`, lat: 40, lon: -105 })).statusCode).toBe(200);
    expect((await add({ name: "p6", lat: 40, lon: -105 })).statusCode).toBe(409);

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/me/places/import",
      headers: { ...json, cookie },
      payload: { places: [{ name: "extra", lat: 40, lon: -105 }] },
    });
    expect(imported.json()).toHaveLength(5);
  });

  it("changes a password and signs other devices out", async () => {
    const { app } = await server();
    const body = { username: "lee", password: "first long passphrase" };
    const a = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: body }));
    const b = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: json, payload: body }));
    const wrong = await app.inject({ method: "POST", url: "/api/v1/me/password", headers: { ...json, cookie: a }, payload: { current: "nope", next: "second long passphrase" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/v1/me/password", headers: { ...json, cookie: a }, payload: { current: body.password, next: "second long passphrase" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: a } })).json().user.username).toBe("lee");
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: b } })).json().user).toBeNull();
  });

  it("takes smoke reports from signed-in people as low-weight crowd evidence, five an hour", async () => {
    const accounts = new MemoryAccountStore();
    const alerts = new AlertEngine({ accounts, log, incidents: () => [], hazards: () => [] });
    const got: { confidence?: number; bearing?: number; label?: string; meta?: unknown }[] = [];
    const app = Fastify();
    await registerAccountRoutes(app, {
      config: cfg,
      accounts,
      alerts,
      sender: null,
      ingest: async (signals) => {
        for (const s of signals) got.push({ confidence: s.providerConfidence, bearing: s.bearing, label: s.label, meta: s.meta });
        return signals.length;
      },
      log,
    });
    const report = (cookie: string | undefined, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/v1/me/reports", headers: { ...json, ...(cookie ? { cookie } : {}) }, payload });
    expect((await report(undefined, { lat: 39.7, lon: -121.6 })).statusCode).toBe(401);
    const cookie = cookieOf(
      await app.inject({ method: "POST", url: "/api/v1/auth/signup", headers: json, payload: { username: "ana", password: "a sensible passphrase" } }),
    );
    expect((await report(cookie, { lat: 51.5, lon: -0.1 })).statusCode).toBe(400);
    expect((await report(cookie, { lat: 39.7, lon: -121.6, description: "Column of smoke over the ridge" })).statusCode).toBe(202);
    expect((await report(cookie, { lat: 39.7, lon: -121.6, bearing: 90, distanceM: 3000 })).statusCode).toBe(202);
    expect(got[0]).toMatchObject({ confidence: 0.45, label: "Column of smoke over the ridge", meta: { reporter: "user" } });
    expect(got[1]).toMatchObject({ confidence: 0.6, bearing: 90 });
    for (let i = 0; i < 3; i++) await report(cookie, { lat: 39.7, lon: -121.6 });
    expect((await report(cookie, { lat: 39.7, lon: -121.6 })).statusCode).toBe(429);
  });
});
