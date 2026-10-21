import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { RedisCache } from "../store/redis.js";
import type { HotspotSource, IncidentSource } from "./service.js";
import { SpreadService } from "./service.js";
import { OnnxSpreadModel } from "./model.js";
import { StaticLayers } from "./static.js";
import { fetchAssets, missingAssets } from "./assets.js";

export { SpreadService } from "./service.js";

export type SpreadState = "disabled" | "downloading" | "ready" | "error";

/**
 * Owns the optional spread feature. If the model or static layers are
 * missing (and can't be downloaded) spread is switched off with a single
 * warning; nothing else in FirePulse depends on it.
 */
export class SpreadRuntime {
  service: SpreadService | null = null;
  state: SpreadState = "disabled";
  reason = "";
  private model: OnnxSpreadModel | null = null;

  constructor(
    private readonly deps: {
      config: AppConfig;
      log: Logger;
      cache: RedisCache | null;
      incidents: IncidentSource;
      hotspots: HotspotSource;
    },
  ) {}

  /** Never throws; resolves once spread is ready or definitively off. */
  async start(): Promise<void> {
    const { config, log } = this.deps;
    const cfg = config.spread;
    if (!cfg.enabled) {
      this.off("SPREAD_ENABLED is off");
      return;
    }
    const paths = { modelPath: cfg.modelPath, staticDir: cfg.staticDir };
    let missing = missingAssets(paths);
    if (missing.length > 0 && cfg.assetsUrl) {
      this.state = "downloading";
      try {
        await fetchAssets(cfg.assetsUrl, paths);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, "spread asset download failed");
      }
      missing = missingAssets(paths);
    }
    if (missing.length > 0) {
      this.off(`missing ${missing.join(", ")}`);
      log.warn({ missing }, "spread forecasts disabled: model or static layers not found");
      return;
    }
    try {
      this.model = new OnnxSpreadModel(cfg.modelPath);
      this.service = new SpreadService({
        predictor: this.model,
        statics: new StaticLayers(cfg.staticDir, 12),
        incidents: this.deps.incidents,
        hotspots: this.deps.hotspots,
        fetch: (url, init) => fetch(url, init),
        cache: this.deps.cache,
        simulated: config.simulated,
        settings: cfg,
        log,
      });
      this.state = "ready";
      log.info({ model: this.model.meta.run }, "spread forecasts enabled");
    } catch (err) {
      this.off(err instanceof Error ? err.message : String(err));
      this.state = "error";
      log.warn({ err: this.reason }, "spread forecasts disabled");
    }
  }

  private off(reason: string): void {
    this.state = "disabled";
    this.reason = reason;
    this.service = null;
  }

  health() {
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      model: this.model?.meta.run ?? null,
      modelLoaded: this.model?.loaded ?? false,
      ...(this.service?.status() ?? {}),
    };
  }
}
