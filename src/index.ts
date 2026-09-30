#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, MIN_FIRMWARE, MIN_PROTOCOL_VERSION, type Config } from "./config.js";
import { InceptionClient } from "./client.js";
import { registerTools } from "./tools.js";

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);

function buildServer(client: InceptionClient, cfg: Config): McpServer {
  const server = new McpServer(
    { name: "inception-mcp", version: "0.1.1" },
    {
      instructions:
        "Read-only access to an Inner Range Inception security controller: area/door/input/output states and the review event log. " +
        "This server cannot arm, disarm, unlock or change anything.",
    },
  );
  registerTools(server, client, cfg);
  return server;
}

function makeAllowlist(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split("/");
    const fam = isIP(addr) === 6 ? "ipv6" : isIP(addr) === 4 ? "ipv4" : undefined;
    if (!fam) throw new Error(`Invalid CIDR in MCP_ALLOWED_CIDRS: ${c}`);
    if (bits === undefined) list.addAddress(addr, fam);
    else list.addSubnet(addr, Number(bits), fam);
  }
  return list;
}

function sourceAllowed(list: BlockList, remote: string | undefined): boolean {
  if (!remote) return false;
  const ip = remote.replace(/^::ffff:/i, ""); // IPv4-mapped IPv6
  const fam = isIP(ip) === 6 ? "ipv6" : isIP(ip) === 4 ? "ipv4" : undefined;
  return !!fam && list.check(ip, fam);
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function checkFirmware(client: InceptionClient, cfg: Config): Promise<void> {
  try {
    const v = await client.protocolVersion();
    if (v < MIN_PROTOCOL_VERSION) {
      log(
        `FATAL: Inception reports REST API protocol version ${v}. This server requires firmware ${MIN_FIRMWARE} or later ` +
          `(protocol version ${MIN_PROTOCOL_VERSION}). Update the controller firmware.`,
      );
      process.exit(1);
    }
    log(`Inception protocol version ${v} (minimum ${MIN_PROTOCOL_VERSION}) OK`);
  } catch (e: any) {
    // Panel unreachable right now: keep serving; tools report the error and it recovers when the panel is back.
    log(`WARNING: could not verify Inception protocol version at startup: ${e?.message ?? e}`);
  }
}

async function main() {
  const cfg = loadConfig();
  const client = new InceptionClient(cfg);
  await checkFirmware(client, cfg);

  if (cfg.transport === "stdio") {
    await buildServer(client, cfg).connect(new StdioServerTransport());
    log("inception-mcp running on stdio");
    return;
  }

  const allow = makeAllowlist(cfg.allowedCidrs);
  const http = createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress;
      if (!sourceAllowed(allow, remote)) {
        log(`rejected ${req.method} ${req.url} from ${remote} (outside MCP_ALLOWED_CIDRS)`);
        return send(res, 403, { error: "Forbidden" });
      }

      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz") return send(res, 200, { status: "ok" });

      if (path !== "/mcp") return send(res, 404, { error: "Not found" });

      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
      if (!tokenMatches(presented, cfg.mcpAuthToken!)) {
        return send(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }

      // Stateless mode: a fresh server + transport per request.
      if (req.method !== "POST") {
        return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { Allow: "POST" });
      }
      const body = await readJson(req);
      const server = buildServer(client, cfg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      log("request error:", e?.message ?? e);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  http.listen(cfg.port, cfg.host, () => {
    log(`inception-mcp listening on http://${cfg.host}:${cfg.port}/mcp (allowed sources: ${cfg.allowedCidrs.join(", ")})`);
  });

  const shutdown = () => {
    log("shutting down");
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log("fatal:", e?.message ?? e);
  process.exit(1);
});
