import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 945 } });
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(9000); // let auto-select settle
// Read which topic auto-select chose
const selected = await page.locator('.topic-select').inputValue().catch(()=>"?");
const metrics = await page.locator(".metric-strip").first().textContent().catch(()=>"?");
console.log("AUTO-SELECTED TOPIC:", selected);
console.log("METRICS:", (metrics||"").trim());
await page.getByRole("button", { name: "Fit", exact: true }).first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/demo_full.png" });
await page.locator(".lidar-3d-stage").first().screenshot({ path: "/tmp/demo_lidar.png" });
await browser.close();
