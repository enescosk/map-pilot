import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errs=[], warns=[];
page.on("console",m=>{ const t=m.text(); if(m.type()==="error")errs.push(t); else if(m.type()==="warning"&&!t.includes("GL Driver")&&!t.includes("DevTools"))warns.push(t); });
page.on("pageerror",e=>errs.push("PAGEERROR: "+String(e)));
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
// Exercise both modes
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(5000);
await page.getByRole("button", { name: "COCKPIT", exact: true }).first().click().catch(()=>{});
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "LiDAR", exact: true }).first().click();
await page.waitForTimeout(3000);
// Toggle 2D/3D
await page.getByRole("button", { name: "2D", exact: true }).first().click().catch(()=>{});
await page.waitForTimeout(2000);
await page.getByRole("button", { name: "3D", exact: true }).first().click().catch(()=>{});
await page.waitForTimeout(2000);
console.log("ERRORS ("+errs.length+"):"); errs.slice(0,10).forEach(e=>console.log("  "+e.slice(0,130)));
console.log("WARNINGS ("+warns.length+"):"); [...new Set(warns)].slice(0,8).forEach(w=>console.log("  "+w.slice(0,130)));
await browser.close();
