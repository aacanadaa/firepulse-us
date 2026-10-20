#!/usr/bin/env node
/**
 * Headless verification harness.
 *   node scripts/shot.mjs [url] [outfile] [waitMs]
 *
 * Captures console errors, failed requests and WebGL/deck diagnostics, then a
 * screenshot. Uses the system Chromium so no browser download is required.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const url = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "screenshots/shot.png";
const waitMs = Number(process.argv[4] ?? 9000);

mkdirSync(dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium-browser",
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--window-size=1600,1000",
    "--disable-features=Translate",
  ],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
const logs = [];
page.on("console", (msg) => {
  const type = msg.type();
  if (type === "error" || type === "warning") logs.push(`[${type}] ${msg.text()}`);
});
page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) =>
  logs.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`),
);
page.on("response", (res) => {
  if (res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`);
});

await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch((e) => logs.push(`[goto] ${e.message}`));
await new Promise((r) => setTimeout(r, waitMs));

const diag = await page.evaluate(() => {
  const canvas = document.querySelector(".maplibregl-canvas");
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  const map = window.__fpMap;
  return {
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    webgl: Boolean(gl),
    renderer: gl?.getParameter(gl.RENDERER) ?? null,
    mapLoaded: map?.loaded?.() ?? null,
    mapZoom: map?.getZoom?.() ?? null,
    mapStyleLoaded: map?.isStyleLoaded?.() ?? null,
    sources: map?.getStyle?.()?.sources ? Object.keys(map.getStyle().sources) : null,
    deckLayers: window.__fpDeck?.props?.layers?.map((l) => l.id) ?? null,
    hotspotCount: window.__fpDeck?.props?.layers?.find((l) => l.id === "hotspot-core")?.props?.data?.length ?? null,
    bodyText: document.body.innerText.slice(0, 400),
  };
});

console.log(JSON.stringify(diag, null, 2));
console.log("--- console ---");
console.log([...new Set(logs)].slice(0, 40).join("\n") || "(none)");

await page.screenshot({ path: out });
console.log(`screenshot: ${out}`);

await browser.close();
