import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const ready={};
await page.addInitScript(()=>{
  window.__cr={};
  const W=window.Worker;
  window.Worker=class extends W{constructor(...a){super(...a);
    this.addEventListener("message",ev=>{
      const d=ev.data;
      if(d?.type==="cloud-ready") window.__cr[d.topic]={frameCount:d.frameCount, renderable:d.renderable?.length};
      if(d?.type==="cloud-skipped") window.__cr[d.topic]={skipped:true, n:d.n};
    });
  }};
});
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(9000);
const cr = await page.evaluate(()=>window.__cr);
const sel = await page.locator('.topic-select').inputValue().catch(()=>"?");
console.log("worker cloud msgs per topic:", JSON.stringify(cr,null,2));
console.log("selected:", sel);
await browser.close();
