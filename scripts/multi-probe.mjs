import WebSocket from "ws";
const URL="ws://172.22.78.35:9090";
const TOPIC=process.env.TOPIC||"/rslidar_points";
const ws=new WebSocket(URL);
const seen=new Map(); let count=0;
ws.on("open",()=>ws.send(JSON.stringify({op:"subscribe",topic:TOPIC})));
ws.on("message",(raw)=>{
  const p=JSON.parse(raw.toString());
  if(p.op!=="publish"||p.topic!==TOPIC)return;
  const m=p.msg;
  const key=`${m.header?.frame_id}|w=${m.width}|step=${m.point_step}`;
  seen.set(key,(seen.get(key)||0)+1);
  if(++count>=20){
    console.log(`${TOPIC} — 20 mesajda görülen şekiller:`);
    for(const[k,v]of seen) console.log(`  ${v}x  ${k}`);
    ws.close(); process.exit(0);
  }
});
setTimeout(()=>{console.log(`${TOPIC}: ${count} mesaj`); for(const[k,v]of seen)console.log(`  ${v}x ${k}`); process.exit(0);},6000);
