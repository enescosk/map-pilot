import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
let crashed=false;
page.on("crash",()=>{crashed=true;console.log("!!! CRASH !!!");});
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(4000);
// Switch to MAP view — accumulates points
await page.getByRole("button", { name: "Map", exact: true }).first().click();
console.log("switched to MAP view");
for (let i=0;i<12 && !crashed;i++){
  await page.waitForTimeout(3000);
  const mem = await page.evaluate(()=>performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):0).catch(()=>-1);
  const strip = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
  console.log(`t=${(i+1)*3}s heap=${mem}MB strip="${(strip||"").trim()}"`);
}
console.log(crashed?"RESULT: crashed":"RESULT: survived");
await browser.close();
