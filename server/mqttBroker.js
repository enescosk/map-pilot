import net from "node:net";
import aedes from "aedes";

const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const broker = aedes();
const server = net.createServer(broker.handle);

server.listen(MQTT_PORT, "0.0.0.0", () => {
  console.log(`MapPilot MQTT broker listening on mqtt://0.0.0.0:${MQTT_PORT}`);
});

broker.on("client", (client) => {
  console.log(`MQTT client connected: ${client?.id}`);
});

broker.on("clientDisconnect", (client) => {
  console.log(`MQTT client disconnected: ${client?.id}`);
});
