import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium-browser",
  headless: "new",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--hide-scrollbars","--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});
const errors = [];
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text().slice(0, 240)); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://localhost:3000/?debug=1", { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 7500));

await page.screenshot({ path: "docs/screenshot-global.png" });

const clicked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".incident-card")];
  const card = cards.find((c) => c.textContent.includes("Sage Fire")) ?? cards.find((c) => c.textContent.includes("Antelope Fire")) ?? cards[0];
  card?.scrollIntoView({ block: "center" });
  card?.click();
  return card?.textContent?.slice(0, 70) ?? null;
});
await new Promise((r) => setTimeout(r, 3400));
await page.screenshot({ path: "docs/screenshot-detail.png" });

await page.keyboard.press("Escape");
await page.evaluate(() => window.__fpMap?.jumpTo({ center: [-119.6, 37.6], zoom: 4.85 }));
await new Promise((r) => setTimeout(r, 1200));
const track = await page.$(".scrub-track");
const box = await track.boundingBox();
await page.mouse.click(box.x + box.width * 0.47, box.y + box.height / 2);
await new Promise((r) => setTimeout(r, 2200));
await page.screenshot({ path: "docs/screenshot-replay.png" });
const replay = await page.evaluate(() => document.body.innerText.includes("REPLAY MODE"));
const replayAges = await page.evaluate(() => [...document.querySelectorAll(".incident-card")].slice(0,3).map(c=>c.innerText.split("\n").slice(0,4).join(" | ")));

await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "LIVE")?.click());
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => window.__fpMap?.jumpTo({ center: [-119.33, 34.49], zoom: 9.2 }));
await new Promise((r) => setTimeout(r, 2400));
await page.screenshot({ path: "docs/screenshot-map.png" });

// mobile
const mobile = await browser.newPage();
mobile.on("pageerror", (e) => errors.push("mobile pageerror: " + e.message));
await mobile.setViewport({ width: 430, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await mobile.goto("http://localhost:3000/", { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 7500));
await mobile.screenshot({ path: "docs/screenshot-mobile.png" });
await mobile.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Incident feed"))?.click());
await new Promise((r) => setTimeout(r, 1200));
await mobile.screenshot({ path: "docs/screenshot-mobile-feed.png" });

console.log(JSON.stringify({ clicked: Boolean(clicked), replay, replayAges, errors: [...new Set(errors)] }, null, 1));
await browser.close();
