// Perf baseline spec. Loads the dashboard, plays the bag for 30 seconds,
// then reports long-task duration histogram.
//
// Acceptance: p95(longTask) < 50ms means main thread is healthy.
// If this fails after a refactor, you broke something.

import { test, expect } from "playwright/test";

test("dashboard idles below 50ms p95 long task with bag playing", async ({ page }) => {
  // Collect long tasks via PerformanceObserver
  await page.addInitScript(() => {
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        (window as unknown as { __longTasks: number[] }).__longTasks.push(entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  });

  await page.goto("/");
  // Wait for backend to be online (the status pill turns green)
  await expect(page.locator(".status-pill.good", { hasText: /Backend online/i })).toBeVisible({ timeout: 10_000 });

  // Press play on the bag (control panel button)
  const startBtn = page.getByRole("button", { name: /Start LiDAR/i });
  if (await startBtn.isEnabled()) await startBtn.click();

  // Let it run for 30 seconds
  await page.waitForTimeout(30_000);

  const longTasks: number[] = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  longTasks.sort((a, b) => a - b);
  const p50 = longTasks[Math.floor(longTasks.length * 0.5)] || 0;
  const p95 = longTasks[Math.floor(longTasks.length * 0.95)] || 0;
  const p99 = longTasks[Math.floor(longTasks.length * 0.99)] || 0;
  const max = longTasks[longTasks.length - 1] || 0;

  console.log(`Long tasks: n=${longTasks.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`);

  // Soft target: 50ms p95. Tighten as perf improves.
  expect(p95).toBeLessThan(50);
});
