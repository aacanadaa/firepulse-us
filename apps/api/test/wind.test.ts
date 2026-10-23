import { describe, expect, it } from "vitest";
import { LiveWind, windFieldsFromPoints, windGrid, type OpenMeteoWindPoint } from "../src/sources/wind.js";

const T0 = Date.parse("2026-10-22T18:00:00Z") / 1000;

function point(speed: number, dir: number, hours = 3): OpenMeteoWindPoint {
  return {
    hourly: {
      time: Array.from({ length: hours }, (_, h) => T0 + h * 3600),
      wind_speed_10m: Array.from({ length: hours }, () => speed),
      wind_direction_10m: Array.from({ length: hours }, () => dir),
    },
  };
}

describe("live wind", () => {
  it("lays a 2° grid over CONUS from the north-west corner", () => {
    const grid = windGrid();
    expect(grid.cols).toBe(31);
    expect(grid.rows).toBe(15);
    expect(grid.lats).toHaveLength(465);
    expect([grid.lons[0], grid.lats[0]]).toEqual([-126, 50]);
    expect([grid.lons[464], grid.lats[464]]).toEqual([-66, 22]);
  });

  it("converts meteorological direction to u/v", () => {
    const grid = windGrid([-120, 38, -118, 38], 2);
    // From the west (270°) blows east; from the north (0°) blows south.
    const [field] = windFieldsFromPoints([point(10, 270), point(5, 0)], grid);
    expect(field!.u[0]).toBeCloseTo(10, 5);
    expect(field!.v[0]).toBeCloseTo(0, 5);
    expect(field!.u[1]).toBeCloseTo(0, 5);
    expect(field!.v[1]).toBeCloseTo(-5, 5);
    expect(field!.speedMax).toBe(10);
    expect(field!.validAt).toBe("2026-10-22T18:00:00.000Z");
  });

  it("fetches in chunks and serves the forecast hour that applies now", async () => {
    const urls: string[] = [];
    const wind = new LiveWind({
      userAgent: "test",
      timeoutMs: 1000,
      pauseMs: 0,
      fetch: async (url) => {
        urls.push(url);
        const n = new URL(url).searchParams.get("latitude")!.split(",").length;
        return new Response(JSON.stringify(Array.from({ length: n }, () => point(4, 180))));
      },
    });
    expect(await wind.refresh()).toBe(3);
    expect(urls).toHaveLength(5);

    const at = (iso: string) => wind.current(Date.parse(iso))?.validAt;
    expect(at("2026-10-22T19:30:00Z")).toBe("2026-10-22T19:00:00.000Z");
    expect(at("2026-10-22T17:00:00Z")).toBeUndefined();
    // Past the end of the cached forecast, show nothing rather than stale wind.
    expect(at("2026-10-23T02:00:00Z")).toBeUndefined();
  });
});
