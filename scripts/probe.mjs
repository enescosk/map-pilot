import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5174/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });
const lidarBtn = page.getByRole("button", { name: "LiDAR", exact: true });
if (await lidarBtn.count()) await lidarBtn.first().click();
await page.waitForTimeout(6000);

// Reach into the THREE scene via the canvas. We can't access refs, but we can
// inspect the WebGL canvas pixels to see if anything non-background is drawn,
// and count distinct colors as a proxy for "points rendered".
const info = await page.evaluate(() => {
  const canvas = document.querySelector(".lidar-3d-stage canvas");
  if (!canvas) return { error: "no canvas" };
  const rect = canvas.getBoundingClientRect();
  // Draw the canvas into a 2D context to sample pixels.
  const c = document.createElement("canvas");
  c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const bg = [7, 10, 12]; // scene background #070a0c
  let nonBg = 0;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) {
      nonBg++;
      if (colors.size < 5000) colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
    }
  }
  return { w: c.width, h: c.height, rect: { w: rect.width, h: rect.height }, nonBgPixels: nonBg, distinctColors: colors.size };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
