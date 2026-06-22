import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 945 } });
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(8000);
try { await page.selectOption('.topic-select', '/rslidar_points'); } catch {}
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Fit", exact: true }).first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/final_real_full.png" });
await browser.close();
