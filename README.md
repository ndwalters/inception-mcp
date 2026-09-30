# inception-mcp

A small, **read-only** [MCP](https://modelcontextprotocol.io) server for the Inner Range **Inception** REST API. It lets an MCP client (Claude Code, Claude Desktop, etc.) see areas, doors, inputs, outputs and the review (event) log. It cannot arm, disarm, unlock, toggle outputs or change configuration.

## Tools

| Tool | What it does |
|---|---|
| `inception_get_system_info` | System name, serial, REST protocol version, and whether it meets the configured minimum |
| `inception_list_items` | Areas / doors / inputs / outputs with **decoded state** (`Disarmed`, `Locked`, `Active`, ...). Filter by `name_contains` and `has_state` (e.g. inputs that are `Active` = open zones) |
| `inception_get_events` | Review log query: time range, categories, event type IDs, involved item IDs, pagination. Events come back with category and event-type name |
| `inception_list_event_types` | Offline search of the 500 event types in the API docs, to find IDs for `message_ids` (e.g. "disarmed" → 5201) |

## Why it is read-only

- The HTTP client only issues `GET` and only to five fixed paths: `/api/protocol-version`, `/api/v1/system-info`, `/api/v1/control/{area|door|input|output}/summary` and `/api/v1/review`. There is no generic "call any endpoint" tool and no request bodies.
- No user, credential, PIN or configuration endpoints are exposed.
- Give the Inception API user only the permissions it needs to *see* items. If the panel has no view-only permission level, remove Arm/Disarm/Control/Access rights entirely: controls would then fail with 403 even if this code had a bug.

## Setup

### 1. Inception API user
1. In Inception: **Users → Manage Users**, add a user (e.g. `MCP Read-only`).
2. Set **Web Page Profile** to `REST Web API User`.
3. Under **Permissions**, add the areas, doors, inputs and outputs you want visible (minimum rights).
4. Under **Credentials → User API Token**, generate a token. Generating a new one invalidates the old one.
5. Enable Review permission for the user if you want events (a 404 on `/review` usually means it is missing).

### 2a. Claude Desktop: one-click bundle (recommended)
1. Download **`inception-mcp.mcpb`** from the [latest release](https://github.com/ndwalters/inception-mcp/releases/latest), then double-click it, or drag it into Claude Desktop (or Settings → Extensions → Advanced settings → Install Extension).
2. Click **Install**, then fill in the form using:
   1. The controller URL (either local `http://192.168.1.50` or through your SkyTunnel serial `https://skytunnel.com.au/Inception/IN12345678`).
   2. The previously created Inception User API Token.
3. Enable the extension.

No Node.js install, no config-file editing: Claude Desktop runs the bundle with its built-in Node runtime, and the token is marked sensitive so it is stored in your OS credential store (Windows Credential Manager / macOS Keychain) rather than in a plain-text JSON file. To change the URL or token later: Settings → Extensions → Inner Range Inception → Configure.

### 2b. Claude Code (or any stdio MCP client)
Needs Node.js 20+.
```bash
npm install          # also builds dist/ via the prepare script
claude mcp add inception --scope user \
  -e INCEPTION_URL=<your Inception URL>\
  -e INCEPTION_API_TOKEN=<your User API Token> \
  -- node "$(pwd)/dist/index.js"
```
Stdio is the default transport, so nothing else is required. The client launches the server as a child process on demand; there is no port and nothing to keep running.

### Building the bundle yourself
```bash
npm install
npm run pack:mcpb     # -> inception-mcp.mcpb (validated against the MCPB manifest schema)
```
`manifest.json` defines the install form (`user_config`) and maps it to environment variables. Bump `version` in `package.json` and re-pack to release an update; installing the new `.mcpb` replaces the old one.

## Running as a shared HTTP service (optional)
Only needed if several machines should share one always-on instance. It requires `MCP_AUTH_TOKEN`.
```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
INCEPTION_URL=http://192.168.1.50 INCEPTION_API_TOKEN=<token> \
HOST=<LAN IP to bind> PORT=3000 npm start
```
Then point a client at `http://<host>:3000/mcp` with header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Two layers of access control apply here:
1. **Bind to a LAN interface**, not `0.0.0.0`, via `HOST`.
2. **`MCP_ALLOWED_CIDRS`** (optional): the server rejects any source address outside the list with 403, before authentication. Default is loopback + RFC1918 + IPv6 ULA/link-local.

The bearer token is always required for `/mcp` in this mode. It's plain HTTP — don't expose it to the internet as-is; put a TLS-terminating reverse proxy in front for remote access.

## Firmware / protocol version

**Requires Inception firmware 7.3.0.8528 or later** (REST API protocol version 18). This is fixed, not configurable: the server checks `GET /api/protocol-version` when it starts and exits with a clear message on older firmware. To check your controller:
```bash
curl http://<inception-ip>/api/protocol-version
```
If the panel is unreachable at startup the server still starts (with a warning) and tools return a clear error until it is back.

## Screenshot

![Inner Range Inception extension in Claude Desktop](screenshot.png)
