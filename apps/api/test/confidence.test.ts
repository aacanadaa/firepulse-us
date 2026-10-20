import { describe, expect, it } from "vitest";
import {
  CORRELATION_DISCOUNT,
  fuseConfidence,
  hotspotConfidence,
  signalWeight,
  ESTIMATE_MAX,
} from "@firepulse/protocol";

const now = Date.parse("2026-10-20T12:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

describe("confidence model", () => {
  it("puts a single unverified crowd report at ~20%", () => {
    const { breakdown } = fuseConfidence(
      [{ source: "crowd", observedAt: at(1), providerConfidence: 0.45 }],
      { at: now },
    );
    expect(breakdown.score).toBeGreaterThanOrEqual(15);
    expect(breakdown.score).toBeLessThanOrEqual(25);
    expect(breakdown.distinctModalities).toBe(1);
  });

  it("puts a verified crowd photo + bearing near 30%", () => {
    const { breakdown } = fuseConfidence(
      [{ source: "crowd", observedAt: at(1), providerConfidence: 0.9 }],
      { at: now },
    );
    expect(breakdown.score).toBeGreaterThanOrEqual(22);
    expect(breakdown.score).toBeLessThanOrEqual(32);
  });

  it("lands CAD dispatch + GOES thermal at ~85%", () => {
    const { breakdown } = fuseConfidence(
      [
        { source: "cad", observedAt: at(1), providerConfidence: 0.85 },
        { source: "goes18", observedAt: at(1), providerConfidence: 0.9, frp: 35 },
      ],
      { at: now },
    );
    expect(breakdown.score).toBeGreaterThanOrEqual(80);
    expect(breakdown.score).toBeLessThanOrEqual(92);
    expect(breakdown.distinctModalities).toBe(2);
  });

  it("discounts two satellites of the same family instead of double counting", () => {
    const both = fuseConfidence(
      [
        { source: "goes18", observedAt: at(1), providerConfidence: 0.9, frp: 20 },
        { source: "viirs", observedAt: at(1), providerConfidence: 0.9, frp: 20 },
      ],
      { at: now },
    );
    const one = fuseConfidence(
      [{ source: "goes18", observedAt: at(1), providerConfidence: 0.9, frp: 20 }],
      { at: now },
    );
    expect(both.breakdown.distinctModalities).toBe(1);
    // Second sensor adds corroboration, not a second full modality.
    expect(both.breakdown.score).toBeGreaterThan(one.breakdown.score);
    expect(both.breakdown.score - one.breakdown.score).toBeLessThan(20);
    expect(CORRELATION_DISCOUNT).toBeGreaterThan(0);
  });

  it("rewards independent modalities", () => {
    const many = fuseConfidence(
      [
        { source: "cad", observedAt: at(1), providerConfidence: 0.9 },
        { source: "goes18", observedAt: at(1), providerConfidence: 0.9, frp: 30 },
        { source: "alertca", observedAt: at(1), providerConfidence: 0.8 },
        { source: "crowd", observedAt: at(1), providerConfidence: 0.8 },
        { source: "purpleair", observedAt: at(1), providerConfidence: 0.7 },
      ],
      { at: now },
    );
    expect(many.breakdown.distinctModalities).toBe(5);
    expect(many.breakdown.corroboration).toBeCloseTo(1.1, 3);
    expect(many.breakdown.score).toBeGreaterThan(90);
  });

  it("never returns 100 for an inference, only for official data", () => {
    const many = fuseConfidence(
      ["cad", "goes18", "viirs", "alertca", "crowd", "purpleair", "raws"].map((source) => ({
        source: source as never,
        observedAt: at(0.5),
        providerConfidence: 1,
        frp: 100,
      })),
      { at: now },
    );
    expect(many.breakdown.score).toBeLessThanOrEqual(ESTIMATE_MAX);
    expect(many.breakdown.score).toBeLessThan(100);

    const official = fuseConfidence([{ source: "nifc", observedAt: at(1) }], { official: true, at: now });
    expect(official.breakdown.score).toBe(100);
  });

  it("decays stale evidence", () => {
    const fresh = fuseConfidence(
      [{ source: "goes18", observedAt: at(2), providerConfidence: 0.9, frp: 20 }],
      { at: now },
    );
    const stale = fuseConfidence(
      [{ source: "goes18", observedAt: at(180), providerConfidence: 0.9, frp: 20 }],
      { at: now },
    );
    expect(stale.breakdown.freshness).toBeLessThan(fresh.breakdown.freshness);
    expect(stale.breakdown.score).toBeLessThan(fresh.breakdown.score * 0.8);
  });

  it("scales signal weight with provider confidence and FRP", () => {
    const low = signalWeight({ source: "goes18", providerConfidence: 0.1, frp: 1 });
    const high = signalWeight({ source: "goes18", providerConfidence: 1, frp: 500 });
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(0.95);
    expect(hotspotConfidence({ source: "viirs", providerConfidence: 0.9, frp: 40 })).toBeGreaterThan(50);
  });

  it("produces a human-readable rationale", () => {
    const { breakdown } = fuseConfidence(
      [
        { source: "cad", observedAt: at(1), providerConfidence: 0.9 },
        { source: "goes18", observedAt: at(1), providerConfidence: 0.9, frp: 20 },
      ],
      { at: now },
    );
    expect(breakdown.rationale).toMatch(/dispatch|satellite/i);
  });
});
