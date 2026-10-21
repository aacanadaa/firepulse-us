import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InferenceSession } from "onnxruntime-node";

export const WIN = 64;
export const CHANNELS = [
  "elevation",
  "wind_u",
  "wind_v",
  "tmmn",
  "tmmx",
  "sph",
  "pr",
  "pdsi",
  "NDVI",
  "population",
  "erc",
  "fire_today",
] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ModelMeta {
  name: string;
  run: string;
  threshold: number;
  testAucPr: number;
  channels: string[];
}

/** Anything that turns raw [n, 12, 64, 64] inputs into [n, 64, 64] scores. */
export interface Predictor {
  readonly meta: ModelMeta;
  predict(raw: Float32Array, n: number): Promise<Float32Array>;
}

export function modelMetaPath(modelPath: string): string {
  return join(dirname(modelPath), "firesight-model.json");
}

export function readModelMeta(path: string): ModelMeta {
  const meta = JSON.parse(readFileSync(path, "utf8")) as ModelMeta;
  if (meta.channels.join(",") !== CHANNELS.join(",")) {
    throw new Error(`model channels ${meta.channels.join(",")} do not match ${CHANNELS.join(",")}`);
  }
  return meta;
}

/**
 * FireSight U-Net in ONNX. The graph takes raw physical units (NaN = missing)
 * and does its own normalization, so callers pass inputs straight through.
 * The session is created on first use; onnxruntime is imported lazily so a
 * missing native binary only disables spread, never the API.
 */
export class OnnxSpreadModel implements Predictor {
  readonly meta: ModelMeta;
  private session: Promise<InferenceSession> | null = null;

  constructor(private readonly modelPath: string, meta?: ModelMeta) {
    this.meta = meta ?? readModelMeta(modelMetaPath(modelPath));
  }

  get loaded(): boolean {
    return this.session !== null;
  }

  private load(): Promise<InferenceSession> {
    if (!this.session) {
      this.session = import("onnxruntime-node")
        .then((ort) =>
          ort.InferenceSession.create(this.modelPath, {
            intraOpNumThreads: 2,
            graphOptimizationLevel: "all",
          }),
        )
        .catch((err) => {
          this.session = null;
          throw err;
        });
    }
    return this.session;
  }

  async predict(raw: Float32Array, n: number): Promise<Float32Array> {
    const size = CHANNELS.length * WIN * WIN;
    if (raw.length !== n * size) throw new Error(`expected ${n * size} values, got ${raw.length}`);
    const session = await this.load();
    const ort = await import("onnxruntime-node");
    const input = new ort.Tensor("float32", raw, [n, CHANNELS.length, WIN, WIN]);
    const out = await session.run({ [session.inputNames[0]!]: input });
    const score = out[session.outputNames[0]!];
    if (!score) throw new Error("model returned no output");
    return score.data as Float32Array;
  }
}
