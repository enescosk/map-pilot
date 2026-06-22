import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let errors=0, crashed=false;
page.on("pageerror",e=>{errors++;console.log("[err]",String(e).slice(0,100));});
page.on("crash",()=>crashed=true);
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(7000);
const before = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
console.log("before:", (before||"").trim().slice(0,40));

// Simulate WS drop by going offline then online
await page.context().setOffline(true);
console.log("--- WS offline ---");
await page.waitForTimeout(4000);
await page.context().setOffline(false);
console.log("--- WS back online ---");
await page.waitForTimeout(8000);
const after = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
const sel = await page.locator('.topic-select').inputValue().catch(()=>"?");
console.log("after reconnect:", (after||"").trim().slice(0,40), "| topic:", sel);
console.log(crashed?"CRASHED":"survived", "| pageErrors:", errors);
await browser.close();
