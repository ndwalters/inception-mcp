// End-to-end smoke test: mock Inception panel + real server process + MCP client.
// Run after `npm run build`:  node scripts/smoke.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PANEL_PORT = 18080;
const MCP_PORT = 13000;
const API_TOKEN = "panel-token-123";
const MCP_TOKEN = "m".repeat(32);
const seen = []; // every request the mock panel received

const A1 = "481d30ac-9108-45e9-b8df-80fe98a2e349";
const IN1 = "07590f0f-e958-4c25-917f-62cf5e46214c";
const summary = {
  "/api/v1/control/area/summary": {
    Areas: {
      [A1]: {
        EntityInfo: { ReportingID: 1, ID: A1, Name: "Default Area" },
        AssociatedInputs: [{ Input: IN1, InputName: "Front PIR", ProcessGroup: "x" }],
        ArmInfo: { EntryDelaySecs: 45, ExitDelaySecs: 60, DeferArmDelaySecs: 3600, AreaWarnTimeSecs: 60, MultiModeArmEnabled: false },
        CurrentState: 2048 | 4096,
        LastStateChangeTime: 1,
        Permissions: 3,
      },
    },
  },
  "/api/v1/control/door/summary": {
    Doors: {
      d1: { EntityInfo: { ReportingID: 1, ID: "d1", Name: "Front Door" }, AttachedReaders: [{ ID: "r1", Name: "Reader", Location: 0 }], CurrentState: 256 | 512, LastStateChangeTime: 2 },
    },
  },
  "/api/v1/control/input/summary": {
    Inputs: {
      [IN1]: { EntityInfo: { ReportingID: 1, ID: IN1, Name: "Front PIR", InputType: 0, IsCustomInput: false }, CurrentState: 1, LastStateChangeTime: 3 },
      i2: { EntityInfo: { ReportingID: 2, ID: "i2", Name: "Back Door Reed", InputType: 0, IsCustomInput: false }, CurrentState: 64, LastStateChangeTime: 4 },
    },
  },
  "/api/v1/control/output/summary": {
    Outputs: { o1: { EntityInfo: { ReportingID: 1, ID: "o1", Name: "Siren" }, CurrentState: 2, LastStateChangeTime: 5 } },
  },
};

const ZERO = "00000000-0000-0000-0000-000000000000";
const panel = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/protocol-version") return json(200, { ProtocolVersion: Number(process.env.MOCK_PROTOCOL ?? 18) });
  if (req.headers.authorization !== `APIToken ${API_TOKEN}`) return json(401, { error: "nope" });
  if (url.pathname === "/api/v1/system-info") return json(200, { SerialNumber: "IN-1234", SystemName: "Home" });
  if (summary[url.pathname]) return json(200, summary[url.pathname]);
  if (url.pathname === "/api/v1/review") {
    return json(200, {
      Offset: Number(url.searchParams.get("offset") ?? 0),
      Count: 2,
      Data: [
        { ID: "e1", Description: "Area Armed by User", MessageCategory: 5000, When: "2026-09-26T08:00:00+10:00", WhenTicks: 1, ReferenceTime: "111", Who: "Alice", WhoID: "u1", What: "Default Area", WhatID: A1, Where: "", WhereID: ZERO },
        { ID: "e2", Description: "Door Opened (unsecured)", MessageCategory: 2002, When: "2026-09-26T08:01:00+10:00", WhenTicks: 2, ReferenceTime: "222", Who: "", WhoID: ZERO, What: "Front Door", WhatID: "d1", Where: "", WhereID: ZERO },
      ],
    });
  }
  json(404, {});
});

function startServer(extraEnv = {}) {
  const proc = spawn("node", ["dist/index.js"], {
    env: { ...process.env, MCP_TRANSPORT: "http", INCEPTION_URL: `http://127.0.0.1:${PANEL_PORT}`, INCEPTION_API_TOKEN: API_TOKEN, MCP_AUTH_TOKEN: MCP_TOKEN, PORT: String(MCP_PORT), HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  return { proc, logs: () => out, exited: new Promise((r) => proc.on("exit", (c) => r(c))) };
}
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("timeout"); };
const text = (r) => r.content[0].text;

await new Promise((r) => panel.listen(PANEL_PORT, "127.0.0.1", r));
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { failures++; console.log("FAIL", name, "\n     ", e.message); } };

// --- main server ---
const s = startServer();
await waitFor(() => /listening/.test(s.logs()));

await check("healthz needs no token", async () => {
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`);
  assert.equal(r.status, 200);
});
await check("mcp without token is 401", async () => {
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});
await check("mcp with wrong token is 401", async () => {
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));

await check("lists exactly the 4 read-only tools, all flagged readOnly", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["inception_get_events", "inception_get_system_info", "inception_list_event_types", "inception_list_items"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});
await check("system info", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_get_system_info", arguments: {} })));
  assert.deepEqual(j, { systemName: "Home", serialNumber: "IN-1234", protocolVersion: 18, requiredProtocolVersion: 18, requiredFirmware: "7.3.0.8528 or later", supported: true });
});
await check("areas decoded", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_list_items", arguments: { type: "area" } })));
  assert.equal(j.items[0].name, "Default Area");
  assert.deepEqual(j.items[0].state, ["Disarmed", "ArmReady"]);
  assert.deepEqual(j.items[0].associatedInputs, [{ id: IN1, name: "Front PIR" }]);
  assert.equal(j.items[0].armInfo.ExitDelaySecs, 60);
});
await check("doors decoded", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_list_items", arguments: { type: "door" } })));
  assert.deepEqual(j.items[0].state, ["Locked", "Closed"]);
  assert.equal(j.items[0].attachedReaders[0].id, "r1");
});
await check("inputs filter by state", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_list_items", arguments: { type: "input", has_state: ["active"] } })));
  assert.equal(j.total, 2); assert.equal(j.matched, 1); assert.equal(j.items[0].name, "Front PIR");
});
await check("outputs decoded", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_list_items", arguments: { type: "output" } })));
  assert.deepEqual(j.items[0].state, ["Off"]);
});
await check("events decoded + query params sent", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_get_events", arguments: { limit: 2, categories: ["Security", "Access"], message_ids: [5000, 5201] } })));
  assert.equal(j.events[0].type, "Security_AreaArmedByUser");
  assert.equal(j.events[0].category, "Security");
  assert.equal(j.events[0].where, undefined);
  assert.equal(j.events[0].whereId, undefined);
  assert.equal(j.events[1].category, "Access");
  assert.equal(j.nextOffset, 2);
  const q = seen.filter((x) => x.path === "/api/v1/review").at(-1).query;
  assert.deepEqual(q, { limit: "2", offset: "0", dir: "desc", categoryFilter: "Security,Access", messageTypeIdFilter: "5000,5201" });
});
await check("events reject start + reference", async () => {
  const r = await client.callTool({ name: "inception_get_events", arguments: { start: "2026-01-01T00:00:00", reference_id: "e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1", reference_time: "1" } });
  assert.equal(r.isError, true);
});
await check("event type search", async () => {
  const j = JSON.parse(text(await client.callTool({ name: "inception_list_event_types", arguments: { query: "area disarmed", category: "Security" } })));
  assert.ok(j.eventTypes.some((e) => e.id === 5201), JSON.stringify(j));
  assert.ok(j.eventTypes.every((e) => e.category === "Security"));
});
await check("catalogue sanity (id counts, categories)", async () => {
  const all = JSON.parse(text(await client.callTool({ name: "inception_list_event_types", arguments: { limit: 200, include_obsolete: true } })));
  assert.ok(all.matched >= 480, `matched ${all.matched}`);
  const other = JSON.parse(text(await client.callTool({ name: "inception_list_event_types", arguments: { limit: 200, include_obsolete: true } })));
  assert.ok(other.eventTypes.length > 0);
});
await check("panel only ever saw GET requests with APIToken auth", async () => {
  assert.ok(seen.length > 5);
  for (const r of seen) assert.equal(r.method, "GET");
  for (const r of seen.filter((x) => x.path !== "/api/protocol-version")) assert.equal(r.auth, `APIToken ${API_TOKEN}`);
});
await client.close();
s.proc.kill("SIGTERM");
await s.exited;

// --- CIDR allowlist: localhost not in allowed range -> 403 ---
const s2 = startServer({ MCP_ALLOWED_CIDRS: "10.99.0.0/16" });
await waitFor(() => /listening/.test(s2.logs()));
await check("source outside MCP_ALLOWED_CIDRS gets 403 (even healthz)", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", headers: { authorization: `Bearer ${MCP_TOKEN}` } })).status, 403);
});
s2.proc.kill("SIGTERM"); await s2.exited;

// --- firmware gate ---
process.env.MOCK_PROTOCOL = "10";
const s3 = startServer();
await check("old protocol version aborts startup", async () => {
  const code = await s3.exited;
  assert.equal(code, 1);
  assert.match(s3.logs(), /protocol version 10\. This server requires firmware 7\.3\.0\.8528 or later/);
});
process.env.MOCK_PROTOCOL = "18";

// --- config validation ---
await check("missing MCP_AUTH_TOKEN refuses to start", async () => {
  const s4 = startServer({ MCP_AUTH_TOKEN: "" });
  assert.equal(await s4.exited, 1);
  assert.match(s4.logs(), /MCP_AUTH_TOKEN is required/);
});

panel.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
