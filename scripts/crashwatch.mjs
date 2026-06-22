import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
let crashed = false;
page.on("crash", () => { crashed = true; console.log("!!! PAGE CRASHED !!!"); });
page.on("console", m => { if (m.type()==="error") console.log("[err]", m.text().slice(0,160)); });
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();

// Sample JS heap every 3s for ~45s
for (let i=0; i<15 && !crashed; i++) {
  await page.waitForTimeout(3000);
  try {
    const mem = await page.evaluate(() => performance.memory ? {
      used: Math.round(performance.memory.usedJSHeapSize/1048576),
      total: Math.round(performance.memory.totalJSHeapSize/1048576),
      limit: Math.round(performance.memory.jsHeapSizeLimit/1048576),
    } : null);
    const pts = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
    console.log(`t=${(i+1)*3}s heap=${mem?`${mem.used}/${mem.total} (limit ${mem.limit})MB`:"n/a"}  strip="${(pts||"").trim().slice(0,40)}"`);
  } catch(e) { console.log("eval failed:", String(e).slice(0,80)); }
}
console.log(crashed ? "RESULT: crashed" : "RESULT: survived 45s");
await browser.close();
