import { distanceToRingKm, SPREAD_BANDS, type LngLat, type SpreadForecast, type SpreadOutlook } from "@firepulse/protocol";

/** Growth must come at least this much closer than today's fire to count as "toward". */
const TOWARD_MARGIN_KM = 1;

/**
 * What a next-day forecast means for one place: how close today's fire
 * is, how close the cells the model scores as likely to burn get, and
 * whether that is a move toward the place. Scores are not probabilities;
 * only the bands are used.
 */
export function forecastOutlook(forecast: SpreadForecast, place: LngLat): SpreadOutlook | null {
  if (forecast.status !== "ready" || !forecast.cells?.length) return null;
  const likely = forecast.threshold ?? SPREAD_BANDS.likely;
  let todayKm = Infinity;
  let likelyKm = Infinity;
  let veryLikelyKm = Infinity;
  for (const cell of forecast.cells) {
    const d = distanceToRingKm(place, cell.ring);
    if (cell.burning) {
      todayKm = Math.min(todayKm, d);
      continue;
    }
    if (cell.score >= likely) likelyKm = Math.min(likelyKm, d);
    if (cell.score >= SPREAD_BANDS.veryLikely) veryLikelyKm = Math.min(veryLikelyKm, d);
  }
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    generatedAt: forecast.generatedAt ?? new Date().toISOString(),
    todayKm: round(todayKm),
    likelyKm: round(likelyKm),
    veryLikelyKm: round(veryLikelyKm),
    toward: Number.isFinite(likelyKm) && (!Number.isFinite(todayKm) || likelyKm <= todayKm - TOWARD_MARGIN_KM),
  };
}
