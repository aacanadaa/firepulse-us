import type { AlertKind, AlertSeverity } from "@firepulse/protocol";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string | null;
  googleSub: string | null;
  googleEmail: string | null;
  displayName: string | null;
  alertKinds: AlertKind[];
  quietStartMin: number | null;
  quietEndMin: number | null;
  timezone: string;
  createdAt: string;
}

export interface PlaceRecord {
  id: string;
  userId: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  createdAt: string;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

export interface AlertDraft {
  userId: string;
  placeId: string;
  kind: AlertKind;
  subjectId: string;
  revision: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  url: string;
  /** When quiet hours hold a non-urgent alert, the earliest send time. */
  notBefore?: string;
  status?: "pending" | "baseline" | "suppressed";
}

export interface AlertRecord extends Required<Omit<AlertDraft, "status">> {
  id: number;
  status: "pending" | "sent" | "no_device" | "failed" | "suppressed" | "baseline";
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export type UserSettings = Pick<UserRecord, "alertKinds" | "quietStartMin" | "quietEndMin" | "timezone">;

/**
 * Accounts, places, push subscriptions and alert deliveries. Postgres in
 * production; an in-memory version keeps keyless local development and
 * tests working.
 */
export interface AccountStore {
  readonly kind: "postgres" | "memory";

  createUser(input: { username: string; passwordHash: string | null; googleSub?: string; googleEmail?: string; displayName?: string }): Promise<UserRecord>;
  userById(id: string): Promise<UserRecord | null>;
  userByUsername(username: string): Promise<UserRecord | null>;
  userByGoogleSub(sub: string): Promise<UserRecord | null>;
  linkGoogle(userId: string, sub: string, email: string | null): Promise<void>;
  updateSettings(userId: string, settings: Partial<UserSettings>): Promise<UserRecord>;
  touchLogin(userId: string): Promise<void>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  createSession(tokenHash: string, userId: string, expiresAt: string, userAgent: string | null): Promise<void>;
  /** Returns the user and extends the session when it is valid. */
  sessionUser(tokenHash: string, now: number, extendTo: string): Promise<UserRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteOtherSessions(userId: string, keepTokenHash: string): Promise<void>;

  places(userId: string): Promise<PlaceRecord[]>;
  allPlaces(): Promise<PlaceRecord[]>;
  /** Every place with its owner's alert settings. */
  watchers(): Promise<Array<PlaceRecord & { settings: UserSettings }>>;
  createPlace(userId: string, input: { name: string; lat: number; lon: number; radiusKm: number }): Promise<PlaceRecord>;
  updatePlace(userId: string, id: string, input: { name?: string; radiusKm?: number }): Promise<PlaceRecord | null>;
  deletePlace(userId: string, id: string): Promise<boolean>;

  saveSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }): Promise<void>;
  deleteSubscription(endpoint: string, userId?: string): Promise<void>;
  subscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  markSubscription(endpoint: string, ok: boolean): Promise<void>;

  /** Inserts drafts whose dedupe key is new; returns those inserted. */
  insertAlerts(drafts: AlertDraft[]): Promise<AlertRecord[]>;
  dueAlerts(now: string, limit: number): Promise<AlertRecord[]>;
  markAlert(id: number, update: { status: AlertRecord["status"]; error?: string; retryAt?: string }): Promise<void>;
  recentAlerts(userId: string, limit: number): Promise<AlertRecord[]>;
  /** Alerts sent to a user since a time, for the hourly cap. */
  sentCountSince(userId: string, since: string): Promise<number>;
}
