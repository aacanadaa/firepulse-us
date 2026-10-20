import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath:"/usr/bin/chromium-browser", headless:"new",
  args:["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--hide-scrollbars","--window-size=1600,1000"],
  defaultViewport:{width:1600,height:1000}});
const page = await browser.newPage();
const errors=[];
page.on("console", m => { if(m.type()==="error" && !m.text().includes("favicon")) errors.push(m.text().slice(0,200)); });
page.on("pageerror", e => errors.push("pageerror: "+e.message));
await page.goto("http://localhost:3000/?debug=1",{waitUntil:"networkidle2",timeout:60000}).catch(()=>{});
await new Promise(r=>setTimeout(r,7000));
await page.screenshot({path:"docs/screenshot-global.png"});

// inspector
const clicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".row")];
  const t = rows.find(r => r.textContent.includes("Antelope Fire")) ?? rows[0];
  t?.click();
  return t?.textContent?.slice(0,50);
});
await new Promise(r=>setTimeout(r,3200));
await page.screenshot({path:"docs/screenshot-detail.png"});
await page.keyboard.press("Escape");
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.evaluate(() => window.__fpMap?.jumpTo({center:[-99.2,38.3], zoom:4}));
await new Promise(r=>setTimeout(r,1200));

// replay
const track = await page.$(".scrub-track, .scrub");
const box = await track.boundingBox();
await page.mouse.click(box.x + box.width * 0.47, box.y + box.height / 2);
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await new Promise(r=>setTimeout(r,2200));
await page.screenshot({path:"docs/screenshot-replay.png"});
await page.evaluate(() => [...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Live")?.click());
await new Promise(r=>setTimeout(r,800));

// H3 on an estimate
await page.evaluate(() => [...document.querySelectorAll("button")].find(b=>b.textContent.includes("Layers"))?.click());
await new Promise(r=>setTimeout(r,300));
await page.evaluate(() => [...document.querySelectorAll(".check-row")].find(b=>b.textContent.includes("H3 cells"))?.click());
await page.keyboard.press("Escape");
await page.evaluate(() => window.__fpMap?.jumpTo({center:[-121.985,37.182], zoom:11.6}));
await new Promise(r=>setTimeout(r,2200));
await page.screenshot({path:"docs/screenshot-h3.png"});
// turn H3 back off
await page.evaluate(() => [...document.querySelectorAll("button")].find(b=>b.textContent.includes("Layers"))?.click());
await new Promise(r=>setTimeout(r,250));
await page.evaluate(() => [...document.querySelectorAll(".check-row")].find(b=>b.textContent.includes("H3 cells"))?.click());
await page.keyboard.press("Escape");

// official perimeter
await page.evaluate(() => window.__fpMap?.jumpTo({center:[-118.43,34.46], zoom:12}));
await new Promise(r=>setTimeout(r,1800));
await page.screenshot({path:"docs/screenshot-map.png"});

// map types, national
await page.evaluate(() => window.__fpMap?.jumpTo({center:[-99.2,38.3], zoom:4}));
await new Promise(r=>setTimeout(r,900));
for (const [label,file] of [["Ink","screenshot-ink"],["Topo","screenshot-topo"],["Sat","screenshot-satellite"]]) {
  await page.evaluate((label) => [...document.querySelectorAll(".segment")].find(x=>x.textContent.trim()===label)?.click(), label);
  await new Promise(r=>setTimeout(r,2800));
  await page.screenshot({path:`docs/${file}.png`});
}
await page.evaluate(() => [...document.querySelectorAll(".segment")].find(x=>x.textContent.trim()==="Atlas")?.click());
await new Promise(r=>setTimeout(r,1500));

// mobile
const mobile = await browser.newPage();
await mobile.setViewport({width:430,height:900,deviceScaleFactor:2,isMobile:true,hasTouch:true});
await mobile.goto("http://localhost:3000/?debug=1",{waitUntil:"networkidle2",timeout:60000}).catch(()=>{});
await new Promise(r=>setTimeout(r,6500));
await mobile.screenshot({path:"docs/screenshot-mobile.png"});
await mobile.evaluate(() => [...document.querySelectorAll("button")].find(b=>b.textContent.includes("Incident feed"))?.click());
await new Promise(r=>setTimeout(r,800));
await mobile.screenshot({path:"docs/screenshot-mobile-feed.png"});

console.log(JSON.stringify({clicked, errors:[...new Set(errors)]},null,1));
await browser.close();
