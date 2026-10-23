import { existsSync, readFileSync } from "node:fs";
import { latLngToCell } from "h3-js";
import type { RawSignal } from "@firepulse/protocol";

/**
 * Cells where satellites see heat that is not a wildfire: gas flares,
 * refineries, steel mills, offshore platforms. Built from a year of FIRMS
 * history by scripts/build-heat-mask.ts.
 */
export class HeatMask {
  constructor(
    private readonly cells: ReadonlySet<string>,
    readonly resolution: number,
  ) {}

  static empty(): HeatMask {
    return new HeatMask(new Set(), 7);
  }

  static load(path: string): HeatMask | null {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as { resolution: number; cells: string[] };
    return new HeatMask(new Set(data.cells), data.resolution);
  }

  get size(): number {
    return this.cells.size;
  }

  covers(point: { lon: number; lat: number }): boolean {
    return this.cells.has(latLngToCell(point.lat, point.lon, this.resolution));
  }

  /** Every thermal member sits on a known static heat source. */
  coversAll(members: RawSignal[]): boolean {
    const thermal = members.filter((m) => m.kind === "thermal");
    return thermal.length > 0 && thermal.every((m) => this.covers(m));
  }
}
