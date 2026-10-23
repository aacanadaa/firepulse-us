import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import {
  ALERT_KINDS,
  type AccountPlace,
  type AccountUser,
  type AlertItem,
  type AlertKind,
  type AuthState,
} from "@firepulse/protocol";
import type { AppConfig } from "../config.js";
import type { AlertEngine } from "../notify/engine.js";
import { pushPayload, type PushSender } from "../notify/outbox.js";
import {
  exchangeGoogleCode,
  googleAuthUrl,
  hashPassword,
  LoginThrottle,
  newToken,
  normalizeUsername,
  passwordProblem,
  pkcePair,
  readCookie,
  safeReturnPath,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  tokenHash,
  usernameFromEmail,
  verifyPassword,
} from "./auth.js";
import type { AccountStore, AlertRecord, PlaceRecord, UserRecord } from "./types.js";

export const MAX_PLACES = 5;
const OAUTH_COOKIE = "fp_oauth";
const OAUTH_TTL_SEC = 600;

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRecord;
    sessionHash?: string;
  }
}

export function publicUser(u: UserRecord): AccountUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? undefined,
    hasPassword: Boolean(u.passwordHash),
    google: Boolean(u.googleSub),
    settings: {
      alertKinds: u.alertKinds,
      quietStartMin: u.quietStartMin,
      quietEndMin: u.quietEndMin,
      timezone: u.timezone,
    },
  };
}

function publicPlace(p: PlaceRecord): AccountPlace {
  return { id: p.id, name: p.name, lat: p.lat, lon: p.lon, radiusKm: p.radiusKm };
}

function publicAlert(a: AlertRecord): AlertItem {
  return {
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    body: a.body,
    url: a.url,
    placeId: a.placeId,
    createdAt: a.createdAt,
    status: a.status,
  };
}

function placeInput(body: unknown): { name: string; lat: number; lon: number; radiusKm: number } | null {
  const b = body as { name?: unknown; lat?: unknown; lon?: unknown; radiusKm?: unknown };
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 80) : "";
  const lat = Number(b?.lat);
  const lon = Number(b?.lon);
  const radiusKm = b?.radiusKm === undefined ? 25 : Number(b.radiusKm);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 200) return null;
  return { name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, radiusKm };
}

function minuteOfDay(v: unknown): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 1440 ? n : NaN;
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Accounts (username + password, Google), watched places, alert settings,
 * push subscriptions and alert history.
 */
export async function registerAccountRoutes(
  // Any logger type: the server is built with pino's.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: FastifyInstance<any, any, any, any>,
  deps: {
    config: AppConfig;
    accounts: AccountStore;
    alerts: AlertEngine;
    sender: PushSender | null;
    log: Logger;
  },
): Promise<void> {
  const { config, accounts, alerts, sender, log } = deps;
  const byIp = new LoginThrottle(20, 15 * 60_000);
  const byName = new LoginThrottle(8, 15 * 60_000);
  const signups = new LoginThrottle(10, 60 * 60_000);
  const allowedOrigins = new Set([config.webOrigin, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);

  /* ----------------------------- plumbing ---------------------------- */

  const sign = (value: string) => createHmac("sha256", config.auth.secret).update(value).digest("base64url");

  function setSession(reply: FastifyReply, token: string | null): void {
    reply.header("set-cookie", sessionCookie(token ?? "", config.auth.secureCookies, token ? SESSION_DAYS * 86_400 : 0));
  }

  async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserRecord): Promise<void> {
    const token = newToken();
    await accounts.createSession(
      tokenHash(token),
      user.id,
      new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
      req.headers["user-agent"] ?? null,
    );
    await accounts.touchLogin(user.id);
    setSession(reply, token);
  }

  // Every account route knows who is asking, if anyone.
  app.addHook("preHandler", async (req, reply) => {
    if (!/^\/api\/v1\/(auth|me|push)\b/.test(req.url)) return;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      const hash = tokenHash(token);
      const user = await accounts.sessionUser(hash, Date.now(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
      if (user) {
        req.user = user;
        req.sessionHash = hash;
      }
    }
    // Changes must come from the web app as JSON: a form on another site
    // can do neither, and SameSite=Lax keeps the cookie off cross-site posts.
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "cross-origin request refused" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return reply.code(415).send({ error: "send JSON" });
      }
    }
  });

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "sign in first" });
  };

  /* ------------------------------- auth ------------------------------ */

  app.get("/api/v1/auth/me", async (req): Promise<AuthState> => ({
    user: req.user ? publicUser(req.user) : null,
    googleEnabled: Boolean(config.auth.google),
    pushPublicKey: config.push.publicKey || null,
  }));

  app.post<{ Body: { username?: unknown; password?: unknown } }>("/api/v1/auth/signup", async (req, reply) => {
    const username = normalizeUsername(req.body?.username);
    if (!username) {
      return reply.code(400).send({ error: "Usernames are 3–32 letters, numbers, dots, dashes or underscores." });
    }
    const problem = passwordProblem(req.body?.password, username);
    if (problem) return reply.code(400).send({ error: problem });
    if (signups.blocked(req.ip)) return reply.code(429).send({ error: "Too many new accounts from here. Try again later." });
    if (await accounts.userByUsername(username)) return reply.code(409).send({ error: "That username is taken." });
    let user: UserRecord;
    try {
      user = await accounts.createUser({ username, passwordHash: await hashPassword(String(req.body!.password)) });
    } catch (err) {
      if ((err as Error).message === "username taken") return reply.code(409).send({ error: "That username is taken." });
      throw err;
    }
    signups.fail(req.ip);
    await startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  app.post<{ Body: { username?: unknown; password?: unknown } }>("/api/v1/auth/login", async (req, reply) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const nameKey = `u:${username ?? ""}`;
    if (byIp.blocked(req.ip) || byName.blocked(nameKey)) {
      return reply.code(429).send({ error: "Too many attempts. Wait 15 minutes and try again." });
    }
    const user = username ? await accounts.userByUsername(username) : null;
    // Hash even when the user doesn't exist, so timing doesn't reveal usernames.
    const ok = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : (await hashPassword(password || "x"), false);
    if (!user || !ok) {
      byIp.fail(req.ip);
      byName.fail(nameKey);
      return reply.code(401).send({
        error: user && !user.passwordHash ? "This account signs in with Google." : "Wrong username or password.",
      });
    }
    byName.clear(nameKey);
    await startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.sessionHash) await accounts.deleteSession(req.sessionHash);
    setSession(reply, null);
    return { ok: true };
  });

  /* ------------------------------ Google ----------------------------- */

  app.get<{ Querystring: { return?: string; link?: string } }>("/api/v1/auth/google/start", async (req, reply) => {
    const google = config.auth.google;
    if (!google) return reply.code(404).send({ error: "Google sign-in is not configured" });
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        state,
        verifier,
        return: safeReturnPath(req.query.return),
        link: req.query.link === "1" && req.user ? req.user.id : null,
        exp: Date.now() + OAUTH_TTL_SEC * 1000,
      }),
    ).toString("base64url");
    reply.header(
      "set-cookie",
      `${OAUTH_COOKIE}=${payload}.${sign(payload)}; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TTL_SEC}${
        config.auth.secureCookies ? "; Secure" : ""
      }`,
    );
    return reply.redirect(googleAuthUrl(google, state, challenge));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/v1/auth/google/callback",
    async (req, reply) => {
      const google = config.auth.google;
      const fail = (reason: string) => reply.redirect(`${config.webOrigin}/?auth_error=${encodeURIComponent(reason)}`);
      if (!google) return fail("Google sign-in is not configured.");
      if (req.query.error) return fail("Google sign-in was cancelled.");

      const raw = readCookie(req.headers.cookie, OAUTH_COOKIE) ?? "";
      const [payload, mac] = raw.split(".");
      const expected = payload ? sign(payload) : "";
      if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
        return fail("Sign-in expired. Please try again.");
      }
      const st = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        state: string;
        verifier: string;
        return: string;
        link: string | null;
        exp: number;
      };
      reply.header("set-cookie", `${OAUTH_COOKIE}=; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=0`);
      if (st.exp < Date.now() || st.state !== req.query.state || !req.query.code) {
        return fail("Sign-in expired. Please try again.");
      }

      let identity;
      try {
        identity = await exchangeGoogleCode(google, req.query.code, st.verifier);
      } catch (err) {
        log.warn({ err }, "google sign-in failed");
        return fail("Google sign-in failed. Please try again.");
      }

      const existing = await accounts.userByGoogleSub(identity.sub);
      let user: UserRecord | null = existing;
      if (st.link) {
        if (existing && existing.id !== st.link) return fail("That Google account is linked to a different FirePulse account.");
        await accounts.linkGoogle(st.link, identity.sub, identity.email);
        user = await accounts.userById(st.link);
      } else if (!user) {
        const base = usernameFromEmail(identity.email, identity.sub);
        for (let i = 0; i < 20 && !user; i++) {
          const candidate = i === 0 ? base : `${base.slice(0, 26)}${Math.floor(1000 + Math.random() * 9000)}`;
          if (await accounts.userByUsername(candidate)) continue;
          try {
            user = await accounts.createUser({
              username: candidate,
              passwordHash: null,
              googleSub: identity.sub,
              googleEmail: identity.email ?? undefined,
              displayName: identity.name ?? undefined,
            });
          } catch {
            /* raced for the same name; try another */
          }
        }
      }
      if (!user) return fail("Couldn't create an account. Please try again.");

      const token = newToken();
      await accounts.createSession(
        tokenHash(token),
        user.id,
        new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
        req.headers["user-agent"] ?? null,
      );
      await accounts.touchLogin(user.id);
      reply.header("set-cookie", [
        `${OAUTH_COOKIE}=; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=0`,
        sessionCookie(token, config.auth.secureCookies),
      ]);
      return reply.redirect(`${config.webOrigin}${st.return}`);
    },
  );

  /* ------------------------------- me -------------------------------- */

  app.post<{ Body: { current?: unknown; next?: unknown } }>(
    "/api/v1/me/password",
    { preHandler: requireUser },
    async (req, reply) => {
      const user = req.user!;
      if (user.passwordHash && !(await verifyPassword(String(req.body?.current ?? ""), user.passwordHash))) {
        return reply.code(401).send({ error: "Your current password is wrong." });
      }
      const problem = passwordProblem(req.body?.next, user.username);
      if (problem) return reply.code(400).send({ error: problem });
      await accounts.setPassword(user.id, await hashPassword(String(req.body!.next)));
      // Every other device has to sign in again with the new password.
      await accounts.deleteOtherSessions(user.id, req.sessionHash ?? "");
      return { ok: true };
    },
  );

  app.get("/api/v1/me/settings", { preHandler: requireUser }, async (req) => publicUser(req.user!).settings);

  app.put<{ Body: Record<string, unknown> }>("/api/v1/me/settings", { preHandler: requireUser }, async (req, reply) => {
    const b = req.body ?? {};
    const update: Parameters<AccountStore["updateSettings"]>[1] = {};
    if (b.alertKinds !== undefined) {
      if (!Array.isArray(b.alertKinds) || b.alertKinds.some((k) => !ALERT_KINDS.includes(k as AlertKind))) {
        return reply.code(400).send({ error: "unknown alert kind" });
      }
      update.alertKinds = [...new Set(b.alertKinds as AlertKind[])];
    }
    if (b.quietStartMin !== undefined || b.quietEndMin !== undefined) {
      const start = minuteOfDay(b.quietStartMin ?? null);
      const end = minuteOfDay(b.quietEndMin ?? null);
      if (Number.isNaN(start) || Number.isNaN(end) || (start === null) !== (end === null)) {
        return reply.code(400).send({ error: "quiet hours need both a start and an end" });
      }
      update.quietStartMin = start;
      update.quietEndMin = end;
    }
    if (b.timezone !== undefined) {
      if (!validTimezone(b.timezone)) return reply.code(400).send({ error: "unknown time zone" });
      update.timezone = b.timezone;
    }
    const user = await accounts.updateSettings(req.user!.id, update);
    await alerts.reload();
    return publicUser(user).settings;
  });

  app.delete("/api/v1/me", { preHandler: requireUser }, async (req, reply) => {
    await accounts.deleteUser(req.user!.id);
    await alerts.reload();
    setSession(reply, null);
    return { ok: true };
  });

  /* ------------------------------ places ----------------------------- */

  app.get("/api/v1/me/places", { preHandler: requireUser }, async (req) =>
    (await accounts.places(req.user!.id)).map(publicPlace),
  );

  app.post<{ Body: unknown }>("/api/v1/me/places", { preHandler: requireUser }, async (req, reply) => {
    const input = placeInput(req.body);
    if (!input) return reply.code(400).send({ error: "a place needs a name, a US location and a radius of 1–200 km" });
    if ((await accounts.places(req.user!.id)).length >= MAX_PLACES) {
      return reply.code(409).send({ error: `You can watch up to ${MAX_PLACES} places.` });
    }
    const place = await accounts.createPlace(req.user!.id, input);
    await alerts.baseline(place.id);
    return publicPlace(place);
  });

  /** Places kept in the browser before signing in move into the account. */
  app.post<{ Body: { places?: unknown[] } }>("/api/v1/me/places/import", { preHandler: requireUser }, async (req) => {
    const existing = await accounts.places(req.user!.id);
    const names = new Set(existing.map((p) => p.name.toLowerCase()));
    const added: PlaceRecord[] = [];
    for (const raw of (Array.isArray(req.body?.places) ? req.body!.places : []).slice(0, MAX_PLACES)) {
      const input = placeInput(raw);
      if (!input || names.has(input.name.toLowerCase()) || existing.length + added.length >= MAX_PLACES) continue;
      const place = await accounts.createPlace(req.user!.id, input);
      await alerts.baseline(place.id);
      names.add(input.name.toLowerCase());
      added.push(place);
    }
    return (await accounts.places(req.user!.id)).map(publicPlace);
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; radiusKm?: unknown } }>(
    "/api/v1/me/places/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : undefined;
      const radiusKm = req.body?.radiusKm === undefined ? undefined : Number(req.body.radiusKm);
      if ((name !== undefined && !name) || (radiusKm !== undefined && !(radiusKm >= 1 && radiusKm <= 200))) {
        return reply.code(400).send({ error: "invalid name or radius" });
      }
      const place = await accounts.updatePlace(req.user!.id, req.params.id, { name, radiusKm });
      if (!place) return reply.code(404).send({ error: "no such place" });
      // A wider radius takes in fires that are already burning: baseline them.
      if (radiusKm !== undefined) await alerts.baseline(place.id);
      else await alerts.reload();
      return publicPlace(place);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/me/places/:id", { preHandler: requireUser }, async (req, reply) => {
    if (!(await accounts.deletePlace(req.user!.id, req.params.id))) return reply.code(404).send({ error: "no such place" });
    await alerts.reload();
    return { ok: true };
  });

  /* ------------------------------ alerts ----------------------------- */

  app.get("/api/v1/me/alerts", { preHandler: requireUser }, async (req) =>
    (await accounts.recentAlerts(req.user!.id, 50)).map(publicAlert),
  );

  /* ------------------------------- push ------------------------------ */

  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>(
    "/api/v1/push/subscribe",
    { preHandler: requireUser },
    async (req, reply) => {
      const endpoint = String(req.body?.endpoint ?? "");
      const p256dh = String(req.body?.keys?.p256dh ?? "");
      const auth = String(req.body?.keys?.auth ?? "");
      let url: URL | null = null;
      try {
        url = new URL(endpoint);
      } catch {
        url = null;
      }
      if (!url || url.protocol !== "https:" || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
        return reply.code(400).send({ error: "invalid push subscription" });
      }
      await accounts.saveSubscription(req.user!.id, { endpoint, p256dh, auth, userAgent: req.headers["user-agent"] ?? null });
      return { ok: true, devices: (await accounts.subscriptions(req.user!.id)).length };
    },
  );

  app.delete<{ Body: { endpoint?: unknown } }>("/api/v1/push/subscribe", { preHandler: requireUser }, async (req) => {
    await accounts.deleteSubscription(String(req.body?.endpoint ?? ""), req.user!.id);
    return { ok: true, devices: (await accounts.subscriptions(req.user!.id)).length };
  });

  app.get("/api/v1/push/devices", { preHandler: requireUser }, async (req) => ({
    devices: (await accounts.subscriptions(req.user!.id)).length,
  }));

  /** Sends a test notification straight to every device, bypassing the queue. */
  app.post("/api/v1/push/test", { preHandler: requireUser }, async (req, reply) => {
    if (!sender) return reply.code(503).send({ error: "push isn't configured on this server" });
    const subs = await accounts.subscriptions(req.user!.id);
    const payload = JSON.stringify(
      pushPayload({
        title: "FirePulse test alert",
        body: "Alerts will look like this. You can change what you get in alert settings.",
        url: "/",
        severity: "info",
        placeId: "test",
        subjectId: "test",
        kind: "new_fire",
      }),
    );
    let sent = 0;
    for (const sub of subs) {
      try {
        await sender.send(sub, payload, { ttlSec: 300, urgency: "normal", topic: "test" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await accounts.deleteSubscription(sub.endpoint);
      }
    }
    return { sent, devices: subs.length };
  });
}
