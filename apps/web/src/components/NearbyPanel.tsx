"use client";

import { useState } from "react";
import type { GeocodeResult, HazardAlertProperties, NearbyFire, NearbySummary } from "@firepulse/protocol";
import { formatAcres, formatAgeShort, formatKm, hazardTier, plainFireStatus } from "@/lib/format";
import { RADIUS_CHOICES, usePlaceSearch, type WatchedPlace } from "@/lib/myplaces";
import { Icon } from "./ui";

interface Props {
  places: WatchedPlace[];
  nearby: Record<string, NearbySummary | undefined>;
  now: number;
  full: boolean;
  onAdd: (place: { name: string; lat: number; lon: number }) => void;
  onRemove: (id: string) => void;
  onRadius: (id: string, radiusKm: number) => void;
  onFocusPlace: (place: WatchedPlace) => void;
  onSelectFire: (fire: NearbyFire) => void;
  /** Prompt to sign in or turn on alerts, shown under the search box. */
  cta?: React.ReactNode;
  /** The smoke report form, shown under the places. */
  report?: React.ReactNode;
}

function until(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  // Name the zone: a watched place can be in a different one from the viewer.
  const when = new Date(t).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `until ${when}`;
}

/** Where to read the alert as issued: NWS's page for that exact point. */
function officialAlertsUrl(place: WatchedPlace): string {
  return `https://forecast.weather.gov/MapClick.php?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`;
}

function AlertBanner({ alert, place }: { alert: HazardAlertProperties; place: WatchedPlace }) {
  const tier = hazardTier(alert.event);
  const text = alert.instruction ?? alert.description;
  return (
    <div className={`np-alert np-alert-${tier}`} role={tier === "act" ? "alert" : undefined}>
      <div className="np-alert-title">
        {alert.event}
        <span className="np-alert-until">{until(alert.ends ?? alert.expires)}</span>
      </div>
      <div className="np-alert-meta">{alert.sender}</div>
      {text ? (
        <details>
          <summary>{tier === "act" ? "What to do" : "Details"}</summary>
          <p>{text}</p>
        </details>
      ) : null}
      <a href={officialAlertsUrl(place)} target="_blank" rel="noreferrer">
        Official alert at weather.gov
      </a>
    </div>
  );
}

/** EPA's plain advice for each AQI range, for PM2.5 (smoke). */
function airAdvice(aqi: number): string | null {
  if (aqi > 200) return "Everyone should avoid time outdoors and keep windows closed.";
  if (aqi > 150) return "Everyone should cut back on time outdoors; sensitive groups should stay in.";
  if (aqi > 100) return "Children, older adults and people with heart or lung conditions should limit time outdoors.";
  return null;
}

function AirLine({ air, now }: { air: NonNullable<NearbySummary["airQuality"]>; now: number }) {
  const advice = airAdvice(air.aqi);
  const tone = air.aqi > 150 ? "bad" : air.aqi > 100 ? "poor" : "";
  return (
    <p className={`np-air ${tone}`}>
      <span>
        Air: <strong>{air.category}</strong> · PM2.5 AQI {air.aqi}
      </span>
      <span className="mono">
        {air.siteName}, {formatKm(air.distanceKm)} · {formatAgeShort(now - Date.parse(air.observedAt))} ago
      </span>
      {advice ? <span>{advice}</span> : null}
    </p>
  );
}

function FireRow({ fire, now, onSelect }: { fire: NearbyFire; now: number; onSelect: () => void }) {
  const inside = fire.distanceKm === 0;
  return (
    <button type="button" className="np-fire" onClick={onSelect}>
      <span className={`np-fire-mark ${fire.kind}`} aria-hidden />
      <span className="np-fire-body">
        <span className="np-fire-name">{fire.name}</span>
        <span className="np-fire-status">{plainFireStatus(fire, now)}</span>
        {fire.outlook ? (
          <span className={`np-fire-outlook ${fire.outlook.toward ? "toward" : ""}`}>
            {fire.outlook.toward
              ? `Forecast: may grow toward here, ${
                  fire.outlook.likelyKm === 0 ? "reaching this place" : `to about ${formatKm(fire.outlook.likelyKm ?? 0)} away`
                } in the next day`
              : "Forecast: not expected to come closer in the next day"}{" "}
            <em>(experimental)</em>
          </span>
        ) : null}
      </span>
      <span className="np-fire-where mono">
        {inside ? "You're inside" : `${formatKm(fire.distanceKm)} ${fire.direction}`}
        <span>{formatAcres(fire.areaAcres)}</span>
      </span>
    </button>
  );
}

function PlaceCard({
  place,
  summary,
  now,
  onRemove,
  onRadius,
  onFocus,
  onSelectFire,
}: {
  place: WatchedPlace;
  summary: NearbySummary | undefined;
  now: number;
  onRemove: () => void;
  onRadius: (km: number) => void;
  onFocus: () => void;
  onSelectFire: (fire: NearbyFire) => void;
}) {
  const fires = summary?.fires ?? [];
  const wildfires = fires.filter((f) => f.cause !== "prescribed");
  const nearest = wildfires[0];
  return (
    <section className="np-place" aria-label={place.name}>
      <div className="np-place-head">
        <button type="button" className="np-place-name" onClick={onFocus} title="Show on map">
          <Icon name="pin" size={12} />
          {place.name}
        </button>
        <select
          className="select"
          value={place.radiusKm}
          onChange={(e) => onRadius(Number(e.target.value))}
          aria-label={`Watch radius for ${place.name}`}
        >
          {RADIUS_CHOICES.map((km) => (
            <option key={km} value={km}>
              {km} km
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Stop watching ${place.name}`} style={{ width: 22, height: 22 }}>
          <Icon name="close" size={11} />
        </button>
      </div>

      {summary?.alerts.map((a) => <AlertBanner key={a.id} alert={a} place={place} />)}

      <p className="np-summary">
        {!summary
          ? "Checking…"
          : wildfires.length === 0
            ? `No wildfires within ${place.radiusKm} km.`
            : `${wildfires.length} ${wildfires.length === 1 ? "wildfire" : "wildfires"} within ${place.radiusKm} km · nearest ${
                nearest!.distanceKm === 0 ? "covers this place" : `${formatKm(nearest!.distanceKm)} ${nearest!.direction}`
              }`}
        {summary && fires.length > wildfires.length
          ? ` · ${fires.length - wildfires.length} planned ${fires.length - wildfires.length === 1 ? "burn" : "burns"}`
          : ""}
      </p>

      {summary?.airQuality ? <AirLine air={summary.airQuality} now={now} /> : null}

      {summary && summary.unconfirmedHeat > 0 ? (
        <p className="np-note">
          Also {summary.unconfirmedHeat} unconfirmed satellite heat {summary.unconfirmedHeat === 1 ? "detection" : "detections"}{" "}
          nearby, usually farm or industrial burns. They show faintly on the map and become fires here if seen again.
        </p>
      ) : null}

      {fires.slice(0, 8).map((f) => (
        <FireRow key={f.id} fire={f} now={now} onSelect={() => onSelectFire(f)} />
      ))}
      {fires.length > 8 ? <p className="np-more mono">+{fires.length - 8} more on the map</p> : null}
    </section>
  );
}

function PlaceSearch({ onAdd, full }: { onAdd: Props["onAdd"]; full: boolean }) {
  const [query, setQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const { results, loading, error } = usePlaceSearch(query);

  const pick = (r: GeocodeResult) => {
    onAdd({ name: r.label.split(",")[0]!.trim() || r.label, lat: r.lat, lon: r.lon });
    setQuery("");
  };

  const locate = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("This browser can't share its location.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onAdd({ name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setGeoError("Location permission was denied. Search for an address instead.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60_000 },
    );
  };

  if (full) return <p className="np-hint">You're watching the maximum of five places.</p>;

  return (
    <div className="np-search">
      <div className="np-search-row">
        <label className="np-input">
          <Icon name="search" size={12} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add an address or town"
            aria-label="Search for a place to watch"
            autoComplete="off"
          />
        </label>
        <button type="button" className="btn" onClick={locate} disabled={locating} title="Use my location">
          <Icon name="target" size={12} />
          {locating ? "Locating…" : "Here"}
        </button>
      </div>
      {query.trim().length >= 3 ? (
        <div className="np-results" role="listbox">
          {loading && results.length === 0 ? <div className="np-hint">Searching…</div> : null}
          {error ? <div className="np-hint">{error}</div> : null}
          {!loading && !error && results.length === 0 ? <div className="np-hint">No US places match.</div> : null}
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} type="button" role="option" aria-selected={false} onClick={() => pick(r)}>
              {r.label}
            </button>
          ))}
        </div>
      ) : null}
      {geoError ? <div className="np-hint">{geoError}</div> : null}
    </div>
  );
}

/** The household view: watched places, alerts covering them, fires nearby. */
export default function NearbyPanel(props: Props) {
  const { places, nearby, now } = props;
  return (
    <div className="np feed thin">
      <PlaceSearch onAdd={props.onAdd} full={props.full} />
      {props.cta}

      {places.length === 0 ? (
        <div className="empty">
          <h4>Watch your home</h4>
          <p>
            Add your address, or a relative's, to see fires and evacuation or fire-weather alerts around it. Places stay in
            this browser.
          </p>
        </div>
      ) : (
        places.map((p) => (
          <PlaceCard
            key={p.id}
            place={p}
            summary={nearby[p.id]}
            now={now}
            onRemove={() => props.onRemove(p.id)}
            onRadius={(km) => props.onRadius(p.id, km)}
            onFocus={() => props.onFocusPlace(p)}
            onSelectFire={props.onSelectFire}
          />
        ))
      )}

      {props.report}

      <p className="np-disclaimer">
        FirePulse is not an official warning service. Evacuation orders come from local authorities: follow them, and call
        911 in an emergency.
      </p>
    </div>
  );
}
