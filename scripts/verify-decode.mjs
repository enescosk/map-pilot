import WebSocket from "ws";
import { pointCloud2ToPoints } from "../server/normalizers/pointCloud2.js";

// OLD buggy decode for comparison
function oldDecode(message) {
  const data = message.data;
  const xF = message.fields.find(f=>f.name==="x");
  const yF = message.fields.find(f=>f.name==="y");
  const zF = message.fields.find(f=>f.name==="z");
  const ps = message.point_step;
  const n = message.width * message.height;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data); // BUG: utf-8
  const pts=[];
  for (let i=0;i<n;i++){
    const o=i*ps;
    const x=buffer.readFloatLE(o+xF.offset), y=buffer.readFloatLE(o+yF.offset), z=buffer.readFloatLE(o+zF.offset);
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))continue;
    if(x===0&&y===0&&z===0)continue;
    pts.push({x,y,z});
  }
  return pts;
}

const URL = process.env.ROS_URL || "ws://172.22.78.35:9090";
const TOPIC = process.env.TOPIC || "/rslidar_points";
const ws = new WebSocket(URL);
let done=false;
const finish=(o)=>{if(done)return;done=true;console.log(o);ws.close();process.exit(0);};
ws.on("open",()=>{ console.error("probing",TOPIC); ws.send(JSON.stringify({op:"subscribe",topic:TOPIC})); });
ws.on("message",(raw)=>{
  const p=JSON.parse(raw.toString());
  if(p.op!=="publish"||p.topic!==TOPIC)return;
  const m=p.msg;
  const oldPts=oldDecode(m);
  const newPts=pointCloud2ToPoints(m);
  const sample=newPts.slice(0,4).map(pt=>`(${pt.x.toFixed(2)},${pt.y.toFixed(2)},${pt.z.toFixed(2)} i:${pt.intensity})`);
  finish(`TOPIC ${TOPIC}\n  width=${m.width} point_step=${m.point_step} frame=${m.header?.frame_id}\n  OLD decode valid points: ${oldPts.length}\n  NEW decode valid points: ${newPts.length}\n  NEW sample: ${sample.join("  ")}`);
});
ws.on("error",(e)=>finish("error "+e));
setTimeout(()=>finish("timeout (topic may not be publishing)"),8000);
