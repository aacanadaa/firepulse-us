#!/usr/bin/env node
/**
 * Renders the PWA and notification icons from apps/web/src/app/icon.svg.
 *   CHROME_PATH=/path/to/chrome node scripts/build-icons.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync } from "node:fs";

const svg = readFileSync("apps/web/src/app/icon.svg", "utf8");
const flame = svg.match(/<path[^>]*\/>/)[0];
const out = "apps/web/public/icons";
mkdirSync(out, { recursive: true });

// Maskable icons are cropped to a circle or squircle: full-bleed background,
// artwork inside the central 80%.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${svg.match(/<defs>[\s\S]*<\/defs>/)[0]}
  <rect width="64" height="64" fill="#0a0d12"/>
  <g transform="translate(6.4 6.4) scale(0.8)"><rect x="6" y="6" width="52" height="52" rx="13" fill="url(#e)"/>${flame}</g></svg>`;
// Android shows the badge as a white silhouette in the status bar.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${flame.replace(/fill="[^"]*"/, 'fill="#ffffff"').replace(/opacity="[^"]*"/, "")}</svg>`;

const jobs = [
  ["icon-192.png", svg, 192],
  ["icon-512.png", svg, 512],
  ["maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", maskable, 180],
  ["badge-96.png", badge, 96],
];

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium-browser", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
for (const [name, markup, size] of jobs) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: `${out}/${name}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`${out}/${name}`);
}
await browser.close();
