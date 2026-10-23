"use client";

import { useState } from "react";
import { accountFetch } from "@/lib/account";
import type { WatchedPlace } from "@/lib/myplaces";

const DIRECTIONS = [
  ["N", 0],
  ["NE", 45],
  ["E", 90],
  ["SE", 135],
  ["S", 180],
  ["SW", 225],
  ["W", 270],
  ["NW", 315],
] as const;

const DISTANCES_KM = [1, 3, 5, 10, 20];

/** "See smoke or fire? Report it": low-weight evidence that never alerts alone. */
export default function ReportSmoke({
  signedIn,
  places,
  onSignIn,
}: {
  signedIn: boolean;
  places: WatchedPlace[];
  onSignIn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<string>("here");
  const [bearing, setBearing] = useState<number | null>(null);
  const [km, setKm] = useState(3);
  const [description, setDescription] = useState("");
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>({ busy: false, message: null, error: false });

  if (!open) {
    return (
      <div className="np-report">
        <button type="button" className="btn" onClick={() => (signedIn ? setOpen(true) : onSignIn())}>
          See smoke or fire? Report it
        </button>
      </div>
    );
  }

  const position = (): Promise<{ lat: number; lon: number }> => {
    const place = places.find((p) => p.id === from);
    if (place) return Promise.resolve({ lat: place.lat, lon: place.lon });
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => reject(new Error("Allow location access, or report from one of your places.")),
        { enableHighAccuracy: true, timeout: 15_000 },
      ),
    );
  };

  const submit = async () => {
    setState({ busy: true, message: null, error: false });
    try {
      const at = await position();
      await accountFetch("/api/v1/me/reports", {
        method: "POST",
        body: { ...at, description, ...(bearing !== null ? { bearing, distanceM: km * 1000 } : {}) },
      });
      setState({ busy: false, message: "Thanks. Reports help confirm fires on the map. They don't trigger alerts on their own.", error: false });
      setDescription("");
    } catch (err) {
      setState({ busy: false, message: err instanceof Error ? err.message : "Couldn't send the report.", error: true });
    }
  };

  return (
    <div className="np-report open">
      <div className="kicker">Report smoke or fire</div>
      <p className="np-emergency">If you see flames or are in danger, call 911 first.</p>
      <label>
        <span>Where are you?</span>
        <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="here">My current location</option>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <span className="np-report-label">Which way is the smoke? (optional)</span>
        <div className="np-compass" role="group" aria-label="Direction to the smoke">
          {DIRECTIONS.map(([label, deg]) => (
            <button key={label} type="button" className={`chip ${bearing === deg ? "active" : ""}`} onClick={() => setBearing(bearing === deg ? null : deg)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {bearing !== null ? (
        <label>
          <span>About how far?</span>
          <select className="select" value={km} onChange={(e) => setKm(Number(e.target.value))}>
            {DISTANCES_KM.map((d) => (
              <option key={d} value={d}>
                {d} km
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        <span>What do you see? (optional)</span>
        <input value={description} maxLength={160} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. a column of white smoke over the ridge" />
      </label>
      {state.message ? <p className={state.error ? "acct-error" : "acct-hint"}>{state.message}</p> : null}
      <div className="acct-actions">
        <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => void submit()}>
          {state.busy ? "Sending…" : "Send report"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
}
