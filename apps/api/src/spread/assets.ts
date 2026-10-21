import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { modelMetaPath } from "./model.js";

const execFileAsync = promisify(execFile);

export interface AssetPaths {
  modelPath: string;
  staticDir: string;
}

/** Files that must exist for spread to run; empty when everything is there. */
export function missingAssets(paths: AssetPaths): string[] {
  return [paths.modelPath, modelMetaPath(paths.modelPath), join(paths.staticDir, "index.json")].filter(
    (p) => !existsSync(p),
  );
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, dest);
}

/**
 * Download whatever is missing from SPREAD_ASSETS_URL, which must hold
 *   firesight-best.onnx, firesight-model.json, static_conus.tar.gz
 * (the tarball contains a top-level static_conus/ folder).
 */
export async function fetchAssets(baseUrl: string, paths: AssetPaths): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  if (!existsSync(paths.modelPath)) await download(`${base}/firesight-best.onnx`, paths.modelPath);
  const meta = modelMetaPath(paths.modelPath);
  if (!existsSync(meta)) await download(`${base}/firesight-model.json`, meta);
  if (!existsSync(join(paths.staticDir, "index.json"))) {
    const parent = dirname(paths.staticDir);
    const tarball = join(parent, "static_conus.tar.gz");
    await download(`${base}/static_conus.tar.gz`, tarball);
    await execFileAsync("tar", ["-xzf", tarball, "-C", parent]);
    await rm(tarball, { force: true });
    if (!existsSync(join(paths.staticDir, "index.json"))) {
      throw new Error(`static_conus.tar.gz did not unpack to ${paths.staticDir}`);
    }
  }
}

// CLI, used by the Dockerfile: node dist/spread/assets.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import("../config.js");
  const paths = { modelPath: config.spread.modelPath, staticDir: config.spread.staticDir };
  if (missingAssets(paths).length === 0) {
    console.log("spread assets present");
  } else if (!config.spread.assetsUrl) {
    console.log("SPREAD_ASSETS_URL not set; spread forecasts will be disabled");
  } else {
    await fetchAssets(config.spread.assetsUrl, paths);
    console.log("spread assets downloaded");
  }
}
