import WebSocket from "ws";
import { pointCloud2ToPoints } from "../server/normalizers/pointCloud2.js";
const URL="ws://172.22.78.35:9090";
const TOPIC=process.env.TOPIC;
const ws=new WebSocket(URL);
let done=false;
const fin=o=>{if(done)return;done=true;console.log(o);ws.close();process.exit(0);};
ws.on("open",()=>ws.send(JSON.stringify({op:"subscribe",topic:TOPIC})));
ws.on("message",raw=>{
  const p=JSON.parse(raw.toString());
  if(p.op!=="publish"||p.topic!==TOPIC||!p.msg.data)return;
  if(p.msg.width<100)return; // skip tiny frames
  const pts=pointCloud2ToPoints(p.msg);
  let mnx=1e9,mxx=-1e9,mny=1e9,mxy=-1e9,mnz=1e9,mxz=-1e9;
  for(const pt of pts){mnx=Math.min(mnx,pt.x);mxx=Math.max(mxx,pt.x);mny=Math.min(mny,pt.y);mxy=Math.max(mxy,pt.y);mnz=Math.min(mnz,pt.z);mxz=Math.max(mxz,pt.z);}
  fin(`${TOPIC} frame=${p.msg.header.frame_id} n=${pts.length}\n  X:[${mnx.toFixed(1)},${mxx.toFixed(1)}] Y:[${mny.toFixed(1)},${mxy.toFixed(1)}] Z:[${mnz.toFixed(1)},${mxz.toFixed(1)}]`);
});
setTimeout(()=>fin(TOPIC+": timeout/empty"),8000);
