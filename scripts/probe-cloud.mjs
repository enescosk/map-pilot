import WebSocket from "ws";
const URL = process.env.ROS_URL || "ws://172.22.78.35:9090";
const ws = new WebSocket(URL);
let done = false;
const finish = (obj) => { if (done) return; done = true; console.log(JSON.stringify(obj, null, 2)); ws.close(); process.exit(0); };
ws.on("open", () => {
  console.error("connected to", URL);
  ws.send(JSON.stringify({ op: "subscribe", topic: "/cloud" }));
});
ws.on("message", (raw) => {
  const p = JSON.parse(raw.toString());
  if (p.op !== "publish" || p.topic !== "/cloud") return;
  const m = p.msg;
  const data = m.data;
  finish({
    frame_id: m.header?.frame_id,
    width: m.width, height: m.height,
    point_step: m.point_step, row_step: m.row_step,
    is_bigendian: m.is_bigendian,
    fields: (m.fields || []).map(f => ({ name: f.name, offset: f.offset, datatype: f.datatype, count: f.count })),
    data_type: typeof data,
    data_isArray: Array.isArray(data),
    data_len: typeof data === "string" ? data.length : (data?.length ?? null),
    data_sample: typeof data === "string" ? data.slice(0, 40) : (Array.isArray(data) ? data.slice(0,12) : null),
  });
});
ws.on("error", (e) => finish({ error: String(e) }));
setTimeout(() => finish({ error: "timeout - no /cloud message in 8s" }), 8000);
