import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(7000);

// Intensity color mode
await page.selectOption('select[aria-label="Point color mode"]', "intensity").catch(()=>{});
await page.getByRole("button", { name: "Fit", exact: true }).first().click();
await page.waitForTimeout(1500);
await page.locator(".lidar-3d-stage").first().screenshot({ path: "/tmp/mode_intensity.png" });

// Distance color mode
await page.selectOption('select[aria-label="Point color mode"]', "distance").catch(()=>{});
await page.waitForTimeout(1200);
await page.locator(".lidar-3d-stage").first().screenshot({ path: "/tmp/mode_distance.png" });
await browser.close();
