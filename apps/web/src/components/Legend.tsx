"use client";

import { MAP_THEMES, MAP_TYPES, type MapType } from "@/lib/places";
import { thermalSwatches } from "@/lib/layers";
import { Icon, type IconName } from "./ui";

interface Props {
  open: boolean;
  onClose: () => void;
  mapType: MapType;
}

/** The mark used on the map, drawn in a 22 × 12 box like the other swatches. */
function HatchSwatch({ color }: { color: string }) {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" className="key-swatch">
      <rect x="0.5" y="0.5" width="21" height="11" fill="none" stroke={color} strokeWidth="1" />
      <path d="M-1 13 11-1M4 13 16-1M9 13 21-1" stroke={color} strokeWidth="0.8" opacity="0.55" />
    </svg>
  );
}

function Dot({ fill, stroke, size = 9 }: { fill?: string; stroke?: string; size?: number }) {
  return (
    <span
      className="key-dot"
      style={{
        width: size,
        height: size,
        background: fill ?? "transparent",
        borderColor: stroke,
        borderWidth: stroke ? 1.5 : 0,
      }}
    />
  );
}

const ICON_KEY: { name: IconName; label: string; note: string }[] = [
  { name: "flame", label: "FirePulse mark", note: "Product identity and estimated-fire accent" },
  { name: "pin", label: "Place", note: "A watched place, and the alerts button" },
  { name: "activity", label: "Incident feed", note: "The ranked list of fires" },
  { name: "layers", label: "Overlays", note: "Layer switches, legend and pipeline health" },
  { name: "key", label: "This key", note: "Map marks and what each glyph means" },
  { name: "hex", label: "H3 cell", note: "Resolution-8 identity grid overlay" },
  { name: "wind", label: "Wind", note: "Direction and relative speed" },
  { name: "target", label: "Focus", note: "Fly to a selected fire or place" },
  { name: "clock", label: "Recency", note: "How long ago a detection was observed" },
  { name: "search", label: "Search", note: "Find a place by name" },
  { name: "sun", label: "Light", note: "Light appearance" },
  { name: "moon", label: "Dark", note: "Dark appearance" },
  { name: "auto", label: "System", note: "Follow the operating system appearance" },
];

export default function Legend({ open, onClose, mapType }: Props) {
  if (!open) return null;
  const theme = MAP_THEMES[mapType];
  const basemap = MAP_TYPES.find((t) => t.id === mapType);

  return (
    <>
      <div className="acct-scrim" onClick={onClose} aria-hidden />
      <aside className="acct-panel" role="dialog" aria-label="Map key" aria-modal="true">
        <div className="acct-head">
          <div>
            <div className="kicker">Map key</div>
            <h2 className="h2" style={{ marginTop: 3 }}>
              Reading the map
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close the key"
            style={{ width: 24, height: 24 }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="acct-section">
          <div className="kicker">Fire marks</div>
          <div className="key-row">
            <HatchSwatch color={theme.official} />
            <span>
              <b>Official perimeter</b>
              <em>Surveyed by NIFC / CAL FIRE, hatched inside</em>
            </span>
          </div>
          <div className="key-row">
            <span
              className="key-swatch key-box"
              style={{ border: `1.5px dashed ${theme.estimated}`, background: theme.estimatedFill }}
            />
            <span>
              <b>Early estimate</b>
              <em>Fused active fire zone before any official record</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot stroke={theme.estimated} size={9} />
            </span>
            <span>
              <b>Unconfirmed heat</b>
              <em>Single satellite pass, drawn faint: often a burn, not a wildfire</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot stroke={theme.labelText} size={11} />
            </span>
            <span>
              <b>Selected fire</b>
              <em>What the inspector and the spread forecast follow</em>
            </span>
          </div>
        </div>

        <div className="acct-section">
          <div className="kicker">Thermal detections</div>
          <div className="key-row">
            <span className="key-swatch key-inline" style={{ gap: 3 }}>
              {thermalSwatches(mapType).map((s, i) => (
                <span
                  key={s.label}
                  style={{
                    width: i === 0 ? 7 : 5,
                    height: i === 0 ? 7 : 5,
                    borderRadius: "50%",
                    background: s.color,
                    display: "inline-block",
                  }}
                />
              ))}
            </span>
            <span>
              <b>Age of the detection</b>
              <em>Large dot = newest · {thermalSwatches(mapType).map((s) => s.label).join(" / ")}</em>
            </span>
          </div>
        </div>

        <div className="acct-section">
          <div className="kicker">Is it still burning?</div>
          <p className="acct-hint" style={{ marginTop: 0 }}>
            Every fire carries the newest evidence we have for it. Fires with no heat for a day
            fade back on the map and are labelled, so the picture shows tonight, not the season.
          </p>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot fill="var(--forest)" size={8} />
            </span>
            <span>
              <b>Active</b>
              <em>Heat or a feed update within 90 minutes</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot fill="var(--warn)" size={8} />
            </span>
            <span>
              <b>Cooling</b>
              <em>No new heat for 1.5–6 hours</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot stroke="var(--faint)" size={9} />
            </span>
            <span>
              <b>Quiet / no recent heat</b>
              <em>Nothing detected for 6 h or more · drawn back</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot stroke="var(--faint)" size={11} />
            </span>
            <span>
              <b>Presumed out</b>
              <em>Contained, and no heat for 6 h</em>
            </span>
          </div>
          <p className="acct-hint">
            Click anywhere near a dot: the map picks the nearest fire within 6 km, so you do not
            have to hit a three-pixel target.
          </p>
        </div>

        <div className="acct-section">
          <div className="kicker">Warnings and weather</div>
          <div className="key-row">
            <span
              className="key-swatch key-box"
              style={{ border: "1.5px solid var(--danger)", background: "rgba(185, 28, 28, 0.13)" }}
            />
            <span>
              <b>Evacuation order or fire warning</b>
              <em>Solid outline · act on this</em>
            </span>
          </div>
          <div className="key-row">
            <span
              className="key-swatch key-box"
              style={{ border: "1px dashed var(--warn)", background: "rgba(180, 83, 9, 0.08)" }}
            />
            <span>
              <b>Red flag or fire weather</b>
              <em>Dashed · smoke is drawn in grey</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline" style={{ gap: 2 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 6,
                    height: 1,
                    background: theme.wind,
                    opacity: 0.45 + i * 0.2,
                    display: "inline-block",
                  }}
                />
              ))}
            </span>
            <span>
              <b>Wind</b>
              <em>Streak direction and length show relative speed</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
                <path
                  d="M4 1.5h5.5v4h5v5"
                  fill="none"
                  stroke={theme.estimated}
                  strokeWidth="1"
                  opacity="0.75"
                />
                <rect x="3" y="0.5" width="7" height="6" fill={theme.estimatedFill} stroke={theme.estimated} strokeWidth="0.7" />
                <rect x="12.5" y="5.5" width="7" height="6" fill={theme.officialFill} stroke={theme.official} strokeWidth="0.7" />
              </svg>
            </span>
            <span>
              <b>H3 cells</b>
              <em>Optional resolution-8 grid for cross-source identity</em>
            </span>
          </div>
          <div className="key-row">
            <span className="key-swatch key-inline">
              <Dot stroke={theme.labelText} size={10} fill={theme.labelBg} />
            </span>
            <span>
              <b>Watched place</b>
              <em>Dashed ring is the alert radius</em>
            </span>
          </div>
        </div>

        <div className="acct-section">
          <div className="kicker">Icon key</div>
          {ICON_KEY.map((item) => (
            <div className="key-row" key={item.name}>
              <span className="key-icon">
                <Icon name={item.name} size={13} />
              </span>
              <span>
                <b>{item.label}</b>
                <em>{item.note}</em>
              </span>
            </div>
          ))}
        </div>

        <div className="acct-section">
          <div className="kicker">Basemap</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-2)" }}>{basemap?.name}</div>
          <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 2 }}>
            {basemap?.note}
          </div>
          <p className="acct-hint" style={{ marginTop: 6 }}>
            The key follows the basemap: the same fire is drawn in ink-on-paper on Atlas and
            chalk-on-carbon on Ink.
          </p>
        </div>
      </aside>
    </>
  );
}
