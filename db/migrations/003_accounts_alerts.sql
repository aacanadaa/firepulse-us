-- =====================================================================
--  003: accounts, watched places, push subscriptions, alert deliveries
-- =====================================================================

create table if not exists firepulse.app_user (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null check (username ~ '^[a-z0-9_.-]{3,32}$'),
  -- scrypt$N$r$p$salt$hash; null for accounts that only use Google.
  password_hash       text,
  google_sub          text unique,
  google_email        text,
  display_name        text,
  -- Alert preferences. Quiet hours are minutes after local midnight.
  alert_kinds         text[] not null default '{evacuation,fire_warning,new_fire,fire_closer,fire_weather,spread}',
  quiet_start_min     smallint check (quiet_start_min between 0 and 1439),
  quiet_end_min       smallint check (quiet_end_min between 0 and 1439),
  timezone            text not null default 'America/Los_Angeles',
  created_at          timestamptz not null default now(),
  last_login_at       timestamptz
);

create unique index if not exists app_user_username on firepulse.app_user (lower(username));

-- Only a hash of the cookie value is stored.
create table if not exists firepulse.user_session (
  token_hash          text primary key,
  user_id             uuid not null references firepulse.app_user (id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  expires_at          timestamptz not null,
  user_agent          text
);

create index if not exists user_session_user on firepulse.user_session (user_id);
create index if not exists user_session_expiry on firepulse.user_session (expires_at);

create table if not exists firepulse.place (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references firepulse.app_user (id) on delete cascade,
  name                text not null check (length(name) between 1 and 80),
  location            geometry(Point, 4326) not null,
  radius_km           real not null default 25 check (radius_km between 1 and 200),
  created_at          timestamptz not null default now()
);

create index if not exists place_user on firepulse.place (user_id);
create index if not exists place_location_gix on firepulse.place using gist (location);

create table if not exists firepulse.push_subscription (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references firepulse.app_user (id) on delete cascade,
  endpoint            text not null unique,
  p256dh              text not null,
  auth                text not null,
  user_agent          text,
  created_at          timestamptz not null default now(),
  last_ok_at          timestamptz,
  failures            integer not null default 0
);

create index if not exists push_subscription_user on firepulse.push_subscription (user_id);

-- One row per alert for one place. (place, kind, subject, revision) is the
-- dedupe key: the same fire or warning never alerts a place twice for the
-- same reason.
create table if not exists firepulse.alert_delivery (
  id                  bigserial primary key,
  user_id             uuid not null references firepulse.app_user (id) on delete cascade,
  place_id            uuid not null references firepulse.place (id) on delete cascade,
  kind                text not null,
  subject_id          text not null,
  revision            text not null,
  severity            text not null check (severity in ('urgent', 'warning', 'info')),
  title               text not null,
  body                text not null,
  url                 text not null,
  -- pending → sent | no_device | failed; baseline rows mark what a place
  -- already knew when it was added and are never sent.
  status              text not null default 'pending'
                        check (status in ('pending', 'sent', 'no_device', 'failed', 'suppressed', 'baseline')),
  not_before          timestamptz not null default now(),
  attempts            integer not null default 0,
  last_error          text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  unique (place_id, kind, subject_id, revision)
);

create index if not exists alert_delivery_due on firepulse.alert_delivery (not_before) where status = 'pending';
create index if not exists alert_delivery_user on firepulse.alert_delivery (user_id, created_at desc);
