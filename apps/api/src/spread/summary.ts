import type { SpreadLevel, SpreadSummary } from "@firepulse/protocol";
import { WIN } from "./model.js";
import { compass } from "./weather.js";

/** Predicted cells this close to today's fire count as its growth. */
export const NEAR_KM = 16;

export function levelFor(newCells: number): SpreadLevel {
  if (newCells === 0) return "none";
  if (newCells <= 5) return "low";
  if (newCells <= 20) return "moderate";
  return "high";
}

export function summaryText(s: Pick<SpreadSummary, "cellsTomorrow" | "direction">): string {
  if (s.cellsTomorrow === 0) return "The model expects little or no active fire here tomorrow.";
  if (s.direction == null) return "The model expects activity tomorrow, but no clear direction of growth.";
  return `The model leans toward growth to the ${s.direction}.`;
}

/**
 * Where the model expects growth: from the centroid of the incident's
 * burning cells toward the score-weighted centroid of nearby cells that
 * are not burning today. Cells are 1 km, so cell distances are km.
 *
 * @param score  [64*64] model scores
 * @param burning [64*64] fire_today for the whole window
 * @param own    [64*64] the incident's own burning cells
 */
export function summarize(
  score: ArrayLike<number>,
  burning: ArrayLike<number>,
  own: ArrayLike<number>,
  threshold: number,
): SpreadSummary {
  let cy = 0;
  let cx = 0;
  let cellsToday = 0;
  for (let i = 0; i < WIN * WIN; i++) {
    if (!own[i]) continue;
    cy += Math.floor(i / WIN);
    cx += i % WIN;
    cellsToday++;
  }
  cy /= Math.max(1, cellsToday);
  cx /= Math.max(1, cellsToday);

  let cellsTomorrow = 0;
  let newCells = 0;
  let w = 0;
  let wy = 0;
  let wx = 0;
  for (let r = 0; r < WIN; r++) {
    for (let c = 0; c < WIN; c++) {
      const i = r * WIN + c;
      if (Math.hypot(r - cy, c - cx) > NEAR_KM) continue;
      const s = score[i]!;
      const notBurning = !burning[i];
      if (s >= threshold) {
        cellsTomorrow++;
        if (notBurning) newCells++;
      }
      if (notBurning) {
        w += s;
        wy += s * r;
        wx += s * c;
      }
    }
  }

  const base = { cellsToday, cellsTomorrow, newCells, direction: null, bearing: null, km: 0 };
  const done = (s: Omit<SpreadSummary, "text" | "level">): SpreadSummary => ({
    ...s,
    text: summaryText(s),
    level: levelFor(s.newCells),
  });
  if (w < 0.5 || newCells === 0) return done(base);
  const north = -(wy / w - cy);
  const east = wx / w - cx;
  const dist = Math.hypot(east, north);
  const km = Math.round(dist * 10) / 10;
  if (dist < 1) return done({ ...base, km });
  const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return done({ ...base, direction: compass(bearing), bearing: Math.round(bearing), km });
}
