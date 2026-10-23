import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/* ==================================================================== */
/*  Passwords, usernames and session tokens                              */
/* ==================================================================== */

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** N=2^15, r=8, p=1: ~30 ms and 32 MB per hash on a server core. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "fp_session";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Lowercase letters, digits, underscore, dot, hyphen; 3 to 32 characters. */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toLowerCase();
  return /^[a-z0-9_.-]{3,32}$/.test(u) ? u : null;
}

export function passwordProblem(password: unknown, username: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `Use at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.toLowerCase().includes(username)) return "Don't include your username in your password.";
  if (/^(.)\1+$/.test(password) || /^(?:0?123456789?|password\d*|qwerty\w*)$/i.test(password)) {
    return "That password is too easy to guess.";
  }
  return null;
}

/** A Google-only account gets a username from the email's local part. */
export function usernameFromEmail(email: string | null, fallback: string): string {
  const base = (email?.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 24);
  return base.length >= 3 ? base : `user${fallback.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are stored by hash, so a leaked table can't be replayed. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_DAYS * 86_400): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Only same-site paths are valid places to return to after sign-in. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw.slice(0, 300);
}

/* ==================================================================== */
/*  Failed-login throttling                                              */
/* ==================================================================== */

/**
 * Counts failures per key in a sliding window. Separate keys for client IP
 * and username stop both spraying and guessing one account.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 50_000) this.failures.clear();
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }
}

/* ==================================================================== */
/*  Google sign-in (OAuth 2.0 authorization code + PKCE)                 */
/* ==================================================================== */

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function googleAuthUrl(cfg: GoogleConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/**
 * Reads the ID token returned by Google's token endpoint. It came straight
 * from Google over TLS in exchange for our client secret, so OpenID Connect
 * lets us skip the signature check; issuer, audience and expiry are still
 * verified.
 */
export function parseGoogleIdToken(idToken: string, clientId: string, now = Date.now()): GoogleIdentity {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("malformed id token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("wrong issuer");
  if (claims.aud !== clientId) throw new Error("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60_000) throw new Error("expired id token");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new Error("no subject");
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}

export async function exchangeGoogleCode(
  cfg: GoogleConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !body.id_token) throw new Error(`Google token exchange failed: ${body.error ?? res.status}`);
  return parseGoogleIdToken(body.id_token, cfg.clientId);
}
