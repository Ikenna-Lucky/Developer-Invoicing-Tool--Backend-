import { server } from "../../src/index";

console.log(JSON.stringify({ event: "fixture.started", port: server.port }));
for await (const line of console) {
  if (line === "stop") process.emit("SIGTERM");
}
