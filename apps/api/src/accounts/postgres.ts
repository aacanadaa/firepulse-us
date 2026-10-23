import type pg from "pg";
import type { AlertKind } from "@firepulse/protocol";
import type {
  AccountStore,
  AlertDraft,
  AlertRecord,
  PlaceRecord,
  PushSubscriptionRecord,
  UserRecord,
  UserSettings,
} from "./types.js";

const USER_COLUMNS = `id, username, password_hash, google_sub, google_email, display_name,
  alert_kinds, quiet_start_min, quiet_end_min, timezone, created_at`;

const PLACE_COLUMNS = `id, user_id, name, st_y(location) as lat, st_x(location) as lon, radius_km, created_at`;

const ALERT_COLUMNS = `id, user_id, place_id, kind, subject_id, revision, severity, title, body, url,
  status, not_before, attempts, created_at, sent_at`;

type Row = Record<string, unknown>;

const iso = (v: unknown): string => new Date(v as string).toISOString();

function mapUser(r: Row): UserRecord {
  return {
    id: String(r.id),
    username: String(r.username),
    passwordHash: (r.password_hash as string | null) ?? null,
    googleSub: (r.google_sub as string | null) ?? null,
    googleEmail: (r.google_email as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    alertKinds: (r.alert_kinds as AlertKind[]) ?? [],
    quietStartMin: r.quiet_start_min == null ? null : Number(r.quiet_start_min),
    quietEndMin: r.quiet_end_min == null ? null : Number(r.quiet_end_min),
    timezone: String(r.timezone),
    createdAt: iso(r.created_at),
  };
}

function mapPlace(r: Row): PlaceRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    lat: Number(r.lat),
    lon: Number(r.lon),
    radiusKm: Number(r.radius_km),
    createdAt: iso(r.created_at),
  };
}

function mapAlert(r: Row): AlertRecord {
  return {
    id: Number(r.id),
    userId: String(r.user_id),
    placeId: String(r.place_id),
    kind: r.kind as AlertKind,
    subjectId: String(r.subject_id),
    revision: String(r.revision),
    severity: r.severity as AlertRecord["severity"],
    title: String(r.title),
    body: String(r.body),
    url: String(r.url),
    status: r.status as AlertRecord["status"],
    notBefore: iso(r.not_before),
    attempts: Number(r.attempts),
    createdAt: iso(r.created_at),
    sentAt: r.sent_at ? iso(r.sent_at) : null,
  };
}

export class PostgresAccountStore implements AccountStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

  async createUser(input: { username: string; passwordHash: string | null; googleSub?: string; googleEmail?: string; displayName?: string }) {
    try {
      const { rows } = await this.pool.query(
        `insert into firepulse.app_user (username, password_hash, google_sub, google_email, display_name)
         values ($1, $2, $3, $4, $5) returning ${USER_COLUMNS}`,
        [input.username, input.passwordHash, input.googleSub ?? null, input.googleEmail ?? null, input.displayName ?? null],
      );
      return mapUser(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new Error("username taken");
      throw err;
    }
  }

  private async oneUser(where: string, value: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query(`select ${USER_COLUMNS} from firepulse.app_user where ${where}`, [value]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  userById(id: string) {
    return this.oneUser("id = $1::uuid", id);
  }

  userByUsername(username: string) {
    return this.oneUser("lower(username) = lower($1)", username);
  }

  userByGoogleSub(sub: string) {
    return this.oneUser("google_sub = $1", sub);
  }

  async linkGoogle(userId: string, sub: string, email: string | null) {
    await this.pool.query(`update firepulse.app_user set google_sub = $2, google_email = $3 where id = $1`, [userId, sub, email]);
  }

  async updateSettings(userId: string, s: Partial<UserSettings>) {
    const { rows } = await this.pool.query(
      `update firepulse.app_user set
         alert_kinds = coalesce($2::text[], alert_kinds),
         quiet_start_min = case when $6::boolean then $3::smallint else quiet_start_min end,
         quiet_end_min = case when $6::boolean then $4::smallint else quiet_end_min end,
         timezone = coalesce($5::text, timezone)
       where id = $1 returning ${USER_COLUMNS}`,
      [
        userId,
        s.alertKinds ?? null,
        s.quietStartMin ?? null,
        s.quietEndMin ?? null,
        s.timezone ?? null,
        "quietStartMin" in s || "quietEndMin" in s,
      ],
    );
    if (!rows[0]) throw new Error("no such user");
    return mapUser(rows[0]);
  }

  async touchLogin(userId: string) {
    await this.pool.query(`update firepulse.app_user set last_login_at = now() where id = $1`, [userId]);
  }

  async setPassword(userId: string, passwordHash: string) {
    await this.pool.query(`update firepulse.app_user set password_hash = $2 where id = $1`, [userId, passwordHash]);
  }

  async deleteUser(userId: string) {
    await this.pool.query(`delete from firepulse.app_user where id = $1`, [userId]);
  }

  async createSession(tokenHash: string, userId: string, expiresAt: string, userAgent: string | null) {
    await this.pool.query(
      `insert into firepulse.user_session (token_hash, user_id, expires_at, user_agent) values ($1, $2, $3, $4)`,
      [tokenHash, userId, expiresAt, userAgent?.slice(0, 300) ?? null],
    );
  }

  async sessionUser(tokenHash: string, now: number, extendTo: string) {
    const { rows } = await this.pool.query(
      `with s as (
         update firepulse.user_session set last_seen_at = now(), expires_at = $3
          where token_hash = $1 and expires_at > $2
          returning user_id)
       select ${USER_COLUMNS.split(",").map((c) => `u.${c.trim()}`).join(", ")}
         from s join firepulse.app_user u on u.id = s.user_id`,
      [tokenHash, new Date(now).toISOString(), extendTo],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async deleteSession(tokenHash: string) {
    await this.pool.query(`delete from firepulse.user_session where token_hash = $1`, [tokenHash]);
  }

  async deleteOtherSessions(userId: string, keepTokenHash: string) {
    await this.pool.query(`delete from firepulse.user_session where user_id = $1 and token_hash <> $2`, [userId, keepTokenHash]);
  }

  async places(userId: string) {
    const { rows } = await this.pool.query(
      `select ${PLACE_COLUMNS} from firepulse.place where user_id = $1 order by created_at`,
      [userId],
    );
    return rows.map(mapPlace);
  }

  async allPlaces() {
    const { rows } = await this.pool.query(`select ${PLACE_COLUMNS} from firepulse.place`);
    return rows.map(mapPlace);
  }

  async watchers() {
    const { rows } = await this.pool.query(
      `select p.id, p.user_id, p.name, st_y(p.location) as lat, st_x(p.location) as lon, p.radius_km, p.created_at,
              u.alert_kinds, u.quiet_start_min, u.quiet_end_min, u.timezone
         from firepulse.place p join firepulse.app_user u on u.id = p.user_id`,
    );
    return rows.map((r) => ({
      ...mapPlace(r),
      settings: {
        alertKinds: r.alert_kinds as AlertKind[],
        quietStartMin: r.quiet_start_min == null ? null : Number(r.quiet_start_min),
        quietEndMin: r.quiet_end_min == null ? null : Number(r.quiet_end_min),
        timezone: String(r.timezone),
      },
    }));
  }

  async createPlace(userId: string, p: { name: string; lat: number; lon: number; radiusKm: number }) {
    const { rows } = await this.pool.query(
      `insert into firepulse.place (user_id, name, location, radius_km)
       values ($1, $2, st_setsrid(st_makepoint($4, $3), 4326), $5) returning ${PLACE_COLUMNS}`,
      [userId, p.name, p.lat, p.lon, p.radiusKm],
    );
    return mapPlace(rows[0]!);
  }

  async updatePlace(userId: string, id: string, p: { name?: string; radiusKm?: number }) {
    const { rows } = await this.pool.query(
      `update firepulse.place set name = coalesce($3, name), radius_km = coalesce($4, radius_km)
        where id = $2::uuid and user_id = $1 returning ${PLACE_COLUMNS}`,
      [userId, id, p.name ?? null, p.radiusKm ?? null],
    );
    return rows[0] ? mapPlace(rows[0]) : null;
  }

  async deletePlace(userId: string, id: string) {
    const { rowCount } = await this.pool.query(`delete from firepulse.place where id = $2::uuid and user_id = $1`, [userId, id]);
    return (rowCount ?? 0) > 0;
  }

  async saveSubscription(userId: string, s: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }) {
    await this.pool.query(
      `insert into firepulse.push_subscription (user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
         auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
      [userId, s.endpoint, s.p256dh, s.auth, s.userAgent?.slice(0, 300) ?? null],
    );
  }

  async deleteSubscription(endpoint: string, userId?: string) {
    await this.pool.query(
      `delete from firepulse.push_subscription where endpoint = $1 and ($2::uuid is null or user_id = $2::uuid)`,
      [endpoint, userId ?? null],
    );
  }

  async subscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    const { rows } = await this.pool.query(
      `select id, user_id, endpoint, p256dh, auth, user_agent from firepulse.push_subscription where user_id = $1`,
      [userId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      endpoint: String(r.endpoint),
      p256dh: String(r.p256dh),
      auth: String(r.auth),
      userAgent: (r.user_agent as string | null) ?? null,
    }));
  }

  async markSubscription(endpoint: string, ok: boolean) {
    await this.pool.query(
      ok
        ? `update firepulse.push_subscription set last_ok_at = now(), failures = 0 where endpoint = $1`
        : `update firepulse.push_subscription set failures = failures + 1 where endpoint = $1`,
      [endpoint],
    );
  }

  async insertAlerts(drafts: AlertDraft[]) {
    if (drafts.length === 0) return [];
    const { rows } = await this.pool.query(
      `insert into firepulse.alert_delivery
         (user_id, place_id, kind, subject_id, revision, severity, title, body, url, status, not_before)
       select x.user_id, x.place_id, x.kind, x.subject_id, x.revision, x.severity, x.title, x.body, x.url,
              coalesce(x.status, 'pending'), coalesce(x.not_before, now())
         from jsonb_to_recordset($1::jsonb) as x(
           user_id uuid, place_id uuid, kind text, subject_id text, revision text, severity text,
           title text, body text, url text, status text, not_before timestamptz)
       on conflict (place_id, kind, subject_id, revision) do nothing
       returning ${ALERT_COLUMNS}`,
      [
        JSON.stringify(
          drafts.map((d) => ({
            user_id: d.userId,
            place_id: d.placeId,
            kind: d.kind,
            subject_id: d.subjectId,
            revision: d.revision,
            severity: d.severity,
            title: d.title,
            body: d.body,
            url: d.url,
            status: d.status ?? null,
            not_before: d.notBefore ?? null,
          })),
        ),
      ],
    );
    return rows.map(mapAlert);
  }

  async dueAlerts(now: string, limit: number) {
    const { rows } = await this.pool.query(
      `select ${ALERT_COLUMNS} from firepulse.alert_delivery
        where status = 'pending' and not_before <= $1
        order by case severity when 'urgent' then 0 when 'warning' then 1 else 2 end, id
        limit $2`,
      [now, limit],
    );
    return rows.map(mapAlert);
  }

  async markAlert(id: number, u: { status: AlertRecord["status"]; error?: string; retryAt?: string }) {
    await this.pool.query(
      u.retryAt
        ? `update firepulse.alert_delivery set attempts = attempts + 1, last_error = $2, not_before = $3 where id = $1`
        : `update firepulse.alert_delivery set attempts = attempts + 1, status = $2::text, last_error = $3,
             sent_at = case when $2::text = 'sent' then now() else sent_at end where id = $1`,
      u.retryAt ? [id, u.error ?? null, u.retryAt] : [id, u.status, u.error ?? null],
    );
  }

  async recentAlerts(userId: string, limit: number) {
    const { rows } = await this.pool.query(
      `select ${ALERT_COLUMNS} from firepulse.alert_delivery
        where user_id = $1 and status <> 'baseline' order by id desc limit $2`,
      [userId, limit],
    );
    return rows.map(mapAlert);
  }

  async sentCountSince(userId: string, since: string) {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from firepulse.alert_delivery
        where user_id = $1 and status = 'sent' and sent_at >= $2`,
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
