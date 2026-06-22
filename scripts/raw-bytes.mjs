import WebSocket from "ws";
const URL="ws://172.22.78.35:9090";
const TOPIC=process.env.TOPIC||"/rslidar_points";
const ws=new WebSocket(URL);
let done=false;
const fin=(o)=>{if(done)return;done=true;console.log(o);ws.close();process.exit(0);};
ws.on("open",()=>ws.send(JSON.stringify({op:"subscribe",topic:TOPIC})));
ws.on("message",(raw)=>{
  const p=JSON.parse(raw.toString());
  if(p.op!=="publish"||p.topic!==TOPIC)return;
  const m=p.msg;
  const data=m.data;
  const buf=Buffer.from(data,"base64");
  // first 3 points (48 bytes), interpret as float32 LE
  let out=`type=${typeof data} b64len=${data.length} decodedBytes=${buf.length} expected=${m.width*m.point_step}\n`;
  out+=`first 32 raw bytes hex: ${buf.subarray(0,32).toString("hex")}\n`;
  for(let i=0;i<3;i++){
    const o=i*16;
    out+=`pt${i}: x=${buf.readFloatLE(o).toFixed(4)} y=${buf.readFloatLE(o+4).toFixed(4)} z=${buf.readFloatLE(o+8).toFixed(4)} i=${buf.readFloatLE(o+12).toFixed(2)}\n`;
  }
  fin(out);
});
ws.on("error",e=>fin("err "+e));
setTimeout(()=>fin("timeout"),8000);
