// Confirms the stdio transport works end-to-end with no HTTP involved.
// Run after `npm run build`:  node scripts/smoke-stdio.mjs
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PANEL_PORT = 18081;
const API_TOKEN = "panel-token-123";

const panel = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (c, b) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (url.pathname === "/api/protocol-version") return json(200, { ProtocolVersion: 18 });
  if (req.headers.authorization !== `APIToken ${API_TOKEN}`) return json(401, {});
  if (url.pathname === "/api/v1/system-info") return json(200, { SerialNumber: "IN-1234", SystemName: "Home" });
  json(404, {});
});
await new Promise((r) => panel.listen(PANEL_PORT, "127.0.0.1", r));

const client = new Client({ name: "smoke-stdio", version: "0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    MCP_TRANSPORT: "stdio",
    INCEPTION_URL: `http://127.0.0.1:${PANEL_PORT}`,
    INCEPTION_API_TOKEN: API_TOKEN,
  },
  stderr: "pipe",
});
await client.connect(transport);

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  ["inception_get_events", "inception_get_system_info", "inception_list_event_types", "inception_list_items"],
);
const r = await client.callTool({ name: "inception_get_system_info", arguments: {} });
const j = JSON.parse(r.content[0].text);
assert.equal(j.systemName, "Home");
assert.equal(j.protocolVersion, 18);

console.log("ok   stdio transport: no HTTP port, no auth token, tools + a live call work");
await client.close();
panel.close();
