import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
let crashed=false, errors=0;
page.on("crash",()=>{crashed=true;console.log("!!! CRASH !!!");});
page.on("pageerror",e=>{errors++;console.log("[pageerror]",String(e).slice(0,120));});
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(4000);

const topics = ["/rslidar_points","/m1/rslidar_points","/cloud","/rslidar_points"];
for (let round=0; round<3 && !crashed; round++){
  for (const t of topics){
    try { await page.selectOption('.topic-select', t); } catch {}
    await page.waitForTimeout(2500);
    const strip = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
    const mem = await page.evaluate(()=>performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):0).catch(()=>-1);
    console.log(`round${round} topic=${t} heap=${mem}MB strip="${(strip||"").trim().slice(0,42)}"`);
  }
}
// Then map view for 10s
await page.getByRole("button", { name: "Map", exact: true }).first().click().catch(()=>{});
await page.waitForTimeout(10000);
const finalMem = await page.evaluate(()=>performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):0).catch(()=>-1);
console.log(`final heap after map view: ${finalMem}MB  pageErrors=${errors}`);
console.log(crashed?"RESULT: CRASHED":"RESULT: survived torture test");
await browser.close();
