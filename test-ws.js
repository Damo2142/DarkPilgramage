const WebSocket = require("ws");
const ws = new WebSocket("wss://localhost:3202?player=dave", { rejectUnauthorized: false });
ws.on("open", () => console.log("WS OPEN"));
ws.on("message", (d) => {
  const m = JSON.parse(d);
  console.log("MSG type:", m.type);
  if (m.map) {
    console.log("  map.id:", m.map.id, "gridSize:", m.map.gridSize);
    console.log("  tokens:", Object.keys(m.map.tokens || {}).length);
    for (const [id, t] of Object.entries(m.map.tokens || {})) {
      console.log("    ", id, "name:", t.name, "type:", t.type);
    }
  }
  ws.close();
});
ws.on("error", (e) => console.log("WS ERROR:", e.message));
