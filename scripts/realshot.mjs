import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const logs=[];
page.on("console",m=>logs.push(`[${m.type()}] ${m.text()}`));
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(8000);

// Pick the dense rslidar topic if available
try { await page.selectOption('.topic-select', '/rslidar_points'); } catch {}
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Fit", exact: true }).first().click();
await page.waitForTimeout(2000);

const metrics = await page.locator(".metric-strip").allTextContents().catch(()=>[]);
const opts = await page.locator(".topic-select option").allTextContents().catch(()=>[]);
console.log("TOPICS:", JSON.stringify(opts));
console.log("METRICS:", JSON.stringify(metrics));
await page.locator(".lidar-3d-stage").first().screenshot({ path: "/tmp/real_fit.png" });

await page.getByRole("button", { name: "Top", exact: true }).first().click();
await page.waitForTimeout(2000);
await page.locator(".lidar-3d-stage").first().screenshot({ path: "/tmp/real_top.png" });
console.log("LOGS:\n"+logs.slice(-8).join("\n"));
await browser.close();
