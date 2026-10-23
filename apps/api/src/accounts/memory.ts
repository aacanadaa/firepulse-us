import { randomUUID } from "node:crypto";
import { ALERT_KINDS } from "@firepulse/protocol";
import type {
  AccountStore,
  AlertDraft,
  AlertRecord,
  PlaceRecord,
  PushSubscriptionRecord,
  UserRecord,
  UserSettings,
} from "./types.js";

/** Accounts for keyless local development and tests; gone on restart. */
export class MemoryAccountStore implements AccountStore {
  readonly kind = "memory" as const;
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  private placeRows = new Map<string, PlaceRecord>();
  private subs = new Map<string, PushSubscriptionRecord>();
  private alerts: AlertRecord[] = [];
  private nextAlertId = 1;

  async createUser(input: { username: string; passwordHash: string | null; googleSub?: string; googleEmail?: string; displayName?: string }): Promise<UserRecord> {
    if (await this.userByUsername(input.username)) throw new Error("username taken");
    const user: UserRecord = {
      id: randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      googleSub: input.googleSub ?? null,
      googleEmail: input.googleEmail ?? null,
      displayName: input.displayName ?? null,
      alertKinds: [...ALERT_KINDS],
      quietStartMin: null,
      quietEndMin: null,
      timezone: "America/Los_Angeles",
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return { ...user };
  }

  async userById(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async userByUsername(username: string) {
    for (const u of this.users.values()) if (u.username.toLowerCase() === username.toLowerCase()) return { ...u };
    return null;
  }

  async userByGoogleSub(sub: string) {
    for (const u of this.users.values()) if (u.googleSub === sub) return { ...u };
    return null;
  }

  async linkGoogle(userId: string, sub: string, email: string | null) {
    const u = this.users.get(userId);
    if (u) Object.assign(u, { googleSub: sub, googleEmail: email });
  }

  async updateSettings(userId: string, settings: Partial<UserSettings>) {
    const u = this.users.get(userId);
    if (!u) throw new Error("no such user");
    Object.assign(u, settings);
    return { ...u };
  }

  async touchLogin() {}

  async setPassword(userId: string, passwordHash: string) {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }

  async deleteUser(userId: string) {
    this.users.delete(userId);
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
    for (const [k, p] of this.placeRows) if (p.userId === userId) this.placeRows.delete(k);
    for (const [k, s] of this.subs) if (s.userId === userId) this.subs.delete(k);
    this.alerts = this.alerts.filter((a) => a.userId !== userId);
  }

  async createSession(tokenHash: string, userId: string, expiresAt: string) {
    this.sessions.set(tokenHash, { userId, expiresAt: Date.parse(expiresAt) });
  }

  async sessionUser(tokenHash: string, now: number, extendTo: string) {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt < now) return null;
    s.expiresAt = Date.parse(extendTo);
    return this.userById(s.userId);
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteOtherSessions(userId: string, keepTokenHash: string) {
    for (const [k, s] of this.sessions) if (s.userId === userId && k !== keepTokenHash) this.sessions.delete(k);
  }

  async places(userId: string) {
    return [...this.placeRows.values()].filter((p) => p.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async allPlaces() {
    return [...this.placeRows.values()];
  }

  async watchers() {
    const out = [];
    for (const p of this.placeRows.values()) {
      const u = this.users.get(p.userId);
      if (!u) continue;
      out.push({
        ...p,
        settings: { alertKinds: [...u.alertKinds], quietStartMin: u.quietStartMin, quietEndMin: u.quietEndMin, timezone: u.timezone },
      });
    }
    return out;
  }

  async createPlace(userId: string, input: { name: string; lat: number; lon: number; radiusKm: number }) {
    const place: PlaceRecord = { id: randomUUID(), userId, ...input, createdAt: new Date().toISOString() };
    this.placeRows.set(place.id, place);
    return { ...place };
  }

  async updatePlace(userId: string, id: string, input: { name?: string; radiusKm?: number }) {
    const p = this.placeRows.get(id);
    if (!p || p.userId !== userId) return null;
    if (input.name !== undefined) p.name = input.name;
    if (input.radiusKm !== undefined) p.radiusKm = input.radiusKm;
    return { ...p };
  }

  async deletePlace(userId: string, id: string) {
    const p = this.placeRows.get(id);
    if (!p || p.userId !== userId) return false;
    this.placeRows.delete(id);
    this.alerts = this.alerts.filter((a) => a.placeId !== id);
    return true;
  }

  async saveSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }) {
    this.subs.set(sub.endpoint, { id: randomUUID(), userId, ...sub });
  }

  async deleteSubscription(endpoint: string, userId?: string) {
    const s = this.subs.get(endpoint);
    if (s && (!userId || s.userId === userId)) this.subs.delete(endpoint);
  }

  async subscriptions(userId: string) {
    return [...this.subs.values()].filter((s) => s.userId === userId);
  }

  async markSubscription() {}

  async insertAlerts(drafts: AlertDraft[]) {
    const out: AlertRecord[] = [];
    for (const d of drafts) {
      const dup = this.alerts.some(
        (a) => a.placeId === d.placeId && a.kind === d.kind && a.subjectId === d.subjectId && a.revision === d.revision,
      );
      if (dup) continue;
      const record: AlertRecord = {
        ...d,
        id: this.nextAlertId++,
        notBefore: d.notBefore ?? new Date().toISOString(),
        status: d.status ?? "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        sentAt: null,
      };
      this.alerts.push(record);
      out.push({ ...record });
    }
    return out;
  }

  async dueAlerts(now: string, limit: number) {
    return this.alerts
      .filter((a) => a.status === "pending" && a.notBefore <= now)
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }

  async markAlert(id: number, update: { status: AlertRecord["status"]; error?: string; retryAt?: string }) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    a.attempts++;
    if (update.retryAt) {
      a.notBefore = update.retryAt;
    } else {
      a.status = update.status;
      if (update.status === "sent") a.sentAt = new Date().toISOString();
    }
  }

  async recentAlerts(userId: string, limit: number) {
    return this.alerts
      .filter((a) => a.userId === userId && a.status !== "baseline")
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }

  async sentCountSince(userId: string, since: string) {
    return this.alerts.filter((a) => a.userId === userId && a.status === "sent" && (a.sentAt ?? "") >= since).length;
  }
}
