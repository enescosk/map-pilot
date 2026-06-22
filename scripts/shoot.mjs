import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5174/";
const OUT = process.env.OUT || "/tmp/lidar.png";
const WAIT = Number(process.env.WAIT || 6000);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });

// Switch to the LiDAR workspace (mode === "debug").
const lidarBtn = page.getByRole("button", { name: "LiDAR", exact: true });
if (await lidarBtn.count()) await lidarBtn.first().click();

await page.waitForTimeout(WAIT);

// Enable the Debug overlay to read valid-point counts.
const dbg = page.getByText("Debug", { exact: true });
if (await dbg.count()) await dbg.first().click();
await page.waitForTimeout(800);

// Click "Fit" to frame the whole cloud.
const fitBtn = page.getByRole("button", { name: "Fit", exact: true });
if (await fitBtn.count()) await fitBtn.first().click();
await page.waitForTimeout(1500);

// Pull the on-screen metric strip + debug text so we can assert data is flowing.
const metrics = await page.locator(".metric-strip").allTextContents().catch(() => []);
const empty = await page.locator(".lidar-empty-state").allTextContents().catch(() => []);
const hud = await page.locator(".lidar-hud").allTextContents().catch(() => []);
const debug = await page.locator(".lidar-debug-card").allTextContents().catch(() => []);
console.log("DEBUG:", JSON.stringify(debug));

const stage = page.locator(".lidar-3d-stage");
if (await stage.count()) {
  await stage.first().screenshot({ path: OUT });
} else {
  await page.screenshot({ path: OUT, fullPage: false });
}

console.log("METRICS:", JSON.stringify(metrics));
console.log("EMPTY:", JSON.stringify(empty));
console.log("HUD:", JSON.stringify(hud));
console.log("CONSOLE:\n" + logs.slice(-30).join("\n"));

await browser.close();
