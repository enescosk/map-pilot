import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let ready=0, skipped=0;
// Hook worker messages by patching in page context
await page.addInitScript(() => {
  window.__cloudReady = 0; window.__cloudSkipped = 0;
  const origWorker = window.Worker;
  window.Worker = class extends origWorker {
    constructor(...a){ super(...a);
      this.addEventListener("message",(ev)=>{
        const t = ev.data?.type;
        if(t==="cloud-ready") window.__cloudReady++;
        else if(t==="cloud-skipped") window.__cloudSkipped++;
      });
    }
  };
});
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(12000);
const counts = await page.evaluate(()=>({ready:window.__cloudReady, skipped:window.__cloudSkipped}));
console.log(`Over 12s: cloud-ready (processed)=${counts.ready}  cloud-skipped (dropped cheaply)=${counts.skipped}`);
console.log(`Processed ${counts.ready} heavy clouds vs ${counts.skipped} skipped — ratio shows non-active topics avoided.`);
await browser.close();
