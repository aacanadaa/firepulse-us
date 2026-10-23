/**
 * Builds the static heat-source mask: H3 cells where satellites see heat
 * that is not a wildfire (gas flares, refineries, steel mills, offshore
 * platforms). Fusion ignores thermal-only clusters that sit entirely in it.
 *
 *   FIRMS_MAP_KEY=... pnpm --filter @firepulse/api heat-mask:build [YYYY-MM-DD]
 *
 * Reads one year of VIIRS S-NPP detections for CONUS ending at the given
 * date (default: today), in 5-day requests: standard processing while it's
 * available, near-real-time after that. A cell is masked when FIRMS itself classes repeated detections
 * there as a static land source or offshore, or when it has heat on 30+
 * distinct days spread over 4+ months (industrial sites burn year-round;
 * wildfires move on and crop burns are seasonal).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latLngToCell } from "h3-js";

export const HEAT_MASK_RESOLUTION = 7;
const BBOX = "-126,23,-66,50";
/** Standard processing (with FIRMS's static-source class) ends a few months back; NRT covers since. */
const ARCHIVE = "VIIRS_SNPP_SP";
const RECENT = "VIIRS_SNPP_NRT";
const ARCHIVE_END = process.env.FIRMS_SP_END ?? "2026-06-30";
const CHUNK_DAYS = 5;
const MIN_STATIC_DETECTIONS = 2;
const MIN_DAYS = 30;
const MIN_MONTHS = 4;

interface CellStats {
  days: Set<string>;
  months: Set<string>;
  staticHits: number;
}

export function accumulate(csv: string, cells: Map<string, CellStats>): number {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const [lat, lon, date, type] = [col("latitude"), col("longitude"), col("acq_date"), col("type")];
  if (lat < 0 || lon < 0 || date < 0) return 0;
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.split(",");
    const la = Number(f[lat]);
    const lo = Number(f[lon]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const cell = latLngToCell(la, lo, HEAT_MASK_RESOLUTION);
    let s = cells.get(cell);
    if (!s) {
      s = { days: new Set(), months: new Set(), staticHits: 0 };
      cells.set(cell, s);
    }
    const day = f[date]!;
    s.days.add(day);
    s.months.add(day.slice(0, 7));
    // FIRMS type: 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore.
    const t = type >= 0 ? Number(f[type]) : 0;
    if (t === 2 || t === 3) s.staticHits++;
    n++;
  }
  return n;
}

export function maskedCells(cells: Map<string, CellStats>): string[] {
  const out: string[] = [];
  for (const [cell, s] of cells) {
    if (s.staticHits >= MIN_STATIC_DETECTIONS || (s.days.size >= MIN_DAYS && s.months.size >= MIN_MONTHS)) out.push(cell);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error("FIRMS_MAP_KEY is required");
  const end = new Date(`${process.argv[2] ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const start = new Date(end.getTime() - 365 * 86_400_000);
  const cells = new Map<string, CellStats>();
  let detections = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += CHUNK_DAYS * 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const product = day <= ARCHIVE_END ? ARCHIVE : RECENT;
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${product}/${BBOX}/${CHUNK_DAYS}/${day}`;
    let csv = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (res?.ok) {
        csv = await res.text();
        if (/^latitude,/.test(csv)) break;
      }
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
    }
    if (!/^latitude,/.test(csv)) throw new Error(`FIRMS gave no data for ${day}: ${csv.slice(0, 120)}`);
    detections += accumulate(csv, cells);
    process.stdout.write(`${day} ${detections} detections, ${cells.size} cells\n`);
  }
  const masked = maskedCells(cells);
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "heat-mask.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      resolution: HEAT_MASK_RESOLUTION,
      product: `${ARCHIVE} to ${ARCHIVE_END}, ${RECENT} after`,
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      rule: `FIRMS type 2/3 on ${MIN_STATIC_DETECTIONS}+ detections, or heat on ${MIN_DAYS}+ days across ${MIN_MONTHS}+ months`,
      cells: masked,
    }) + "\n",
  );
  process.stdout.write(`masked ${masked.length} of ${cells.size} cells → ${out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
