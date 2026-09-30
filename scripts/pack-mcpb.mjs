// Builds inception-mcp.mcpb: a one-click Claude Desktop bundle.
// Stages dist/ + production node_modules + manifest into build/bundle, then validates and packs.
// Run: npm run pack:mcpb
import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const run = (cmd, cwd = ".") => execSync(cmd, { cwd, stdio: "inherit" });
const stage = "build/bundle";

// Keep manifest version in step with package.json.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

rmSync("build", { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["dist", "manifest.json", "package.json", "package-lock.json", "README.md"]) {
  cpSync(f, `${stage}/${f}`, { recursive: true });
}
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);
run("npx --yes @anthropic-ai/mcpb@2 validate manifest.json", stage);
run(`npx --yes @anthropic-ai/mcpb@2 pack . ../../inception-mcp.mcpb`, stage);
rmSync("build", { recursive: true, force: true });
console.log("\nCreated inception-mcp.mcpb");
