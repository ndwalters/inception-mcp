/** Firmware 7.3.0.8528 reports REST API protocol version 18. Older firmware is not supported. */
export const MIN_PROTOCOL_VERSION = 18;
export const MIN_FIRMWARE = "7.3.0.8528";

export interface Config {
  /** Base URL of the Inception controller, without /api/v1 (e.g. http://192.168.1.50). */
  inceptionUrl: string;
  /** User API Token generated in Inception: Users > Credentials > User API Token. */
  apiToken: string;
  requestTimeoutMs: number;

  transport: "http" | "stdio";
  host: string;
  port: number;
  /** Bearer token MCP clients must present (http transport). */
  mcpAuthToken?: string;
  /** Only these source networks may reach the MCP endpoint (http transport). */
  allowedCidrs: string[];
}

/** Loopback + RFC1918 + IPv6 loopback/ULA/link-local. */
export const LAN_CIDRS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

function int(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = (env.INCEPTION_URL ?? "").trim();
  if (!rawUrl) throw new Error("INCEPTION_URL is required (e.g. http://192.168.1.50)");
  if (!/^https?:\/\//i.test(rawUrl)) throw new Error("INCEPTION_URL must start with http:// or https://");
  // Accept the bare host or a URL that already ends in /api/v1.
  const inceptionUrl = rawUrl.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");

  const apiToken = (env.INCEPTION_API_TOKEN ?? "").trim();
  if (!apiToken) {
    throw new Error("INCEPTION_API_TOKEN is required (Inception > Users > Credentials > User API Token)");
  }

  const transport = (env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (transport !== "http" && transport !== "stdio") {
    throw new Error("MCP_TRANSPORT must be 'http' or 'stdio'");
  }

  const mcpAuthToken = (env.MCP_AUTH_TOKEN ?? "").trim() || undefined;
  if (transport === "http" && !mcpAuthToken) {
    throw new Error("MCP_AUTH_TOKEN is required for the http transport");
  }
  if (mcpAuthToken && mcpAuthToken.length < 24) {
    throw new Error("MCP_AUTH_TOKEN must be at least 24 characters (try: openssl rand -hex 32)");
  }

  const cidrEnv = (env.MCP_ALLOWED_CIDRS ?? "").trim();
  const allowedCidrs = cidrEnv
    ? cidrEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : LAN_CIDRS;

  return {
    inceptionUrl,
    apiToken,
    requestTimeoutMs: int("INCEPTION_TIMEOUT_MS", env.INCEPTION_TIMEOUT_MS, 15000),
    transport,
    host: (env.HOST ?? "0.0.0.0").trim(),
    port: int("PORT", env.PORT, 3000),
    mcpAuthToken,
    allowedCidrs,
  };
}
