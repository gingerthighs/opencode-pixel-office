// Cross-platform installer: builds the plugin and drops it into opencode's plugin folder.
// Run through install.sh / install.ps1, or directly: node scripts/install.ts [options]

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, opencodeConfigDir } from "../src/config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = "pixel-office.js";

const HELP = `opencode-pixel-office installer

Usage: install.sh [options]   |   install.ps1 [options]   |   node scripts/install.ts [options]

  --project <dir>   install into <dir>/.opencode/plugins instead of the global plugin folder
  --port <n>        port for the web UI (default 4777)
  --host <addr>     bind address: 127.0.0.1 (default, this machine only) or 0.0.0.0 (LAN/Tailscale)
  --token <secret>  require a token for the UI; "auto" generates one
  --skip-build      use the existing dist/${PLUGIN}
  --uninstall       remove the plugin (add --purge to also delete ${CONFIG_FILE})
  -h, --help        show this help
`;

interface Args {
  project?: string;
  port?: number;
  host?: string;
  token?: string;
  skipBuild: boolean;
  uninstall: boolean;
  purge: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { skipBuild: false, uninstall: false, purge: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^-{1,2}/, "").toLowerCase();
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      return v;
    };
    switch (k) {
      case "project":
        a.project = next();
        break;
      case "port": {
        const p = Number(next());
        if (!Number.isInteger(p) || p < 1 || p > 65535) fail("--port must be between 1 and 65535");
        a.port = p;
        break;
      }
      case "host":
        a.host = next();
        break;
      case "token":
        a.token = next();
        break;
      case "skip-build":
      case "skipbuild":
        a.skipBuild = true;
        break;
      case "uninstall":
        a.uninstall = true;
        break;
      case "purge":
        a.purge = true;
        break;
      case "h":
      case "help":
        console.log(HELP);
        process.exit(0);
      default:
        fail(`Unknown option: ${argv[i]}\n\n${HELP}`);
    }
  }
  return a;
}

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const step = (msg: string) => console.log(`▸ ${msg}`);
const ok = (msg: string) => console.log(`✔ ${msg}`);

function run(cmd: string, args: string[], shell = false) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} ist fehlgeschlagen`);
}

const args = parse(process.argv.slice(2));
const configDir = opencodeConfigDir();
const pluginDir = args.project ? join(resolve(args.project), ".opencode", "plugins") : join(configDir, "plugins");
const target = join(pluginDir, PLUGIN);
const configFile = join(configDir, CONFIG_FILE);

if (args.uninstall) {
  if (existsSync(target)) {
    rmSync(target);
    ok(`removed: ${target}`);
  } else {
    console.log(`– nothing to remove in ${pluginDir}`);
  }
  if (args.purge && existsSync(configFile)) {
    rmSync(configFile);
    ok(`removed: ${configFile}`);
  }
  console.log("opencode picks this up on its next start (2.x also notices while running).");
  process.exit(0);
}

// 1. build
const dist = join(ROOT, "dist", PLUGIN);
if (!args.skipBuild) {
  if (!existsSync(join(ROOT, "node_modules", "esbuild"))) {
    step("installing build dependencies (npm ci)");
    // npm is a .cmd shim on Windows, which only runs through a shell
    run("npm", existsSync(join(ROOT, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], process.platform === "win32");
  }
  step("building dist/" + PLUGIN);
  run(process.execPath, ["build.ts"]);
}
if (!existsSync(dist)) fail(`dist/${PLUGIN} is missing – run again without --skip-build`);

// 2. install
mkdirSync(pluginDir, { recursive: true });
copyFileSync(dist, target);
ok(`plugin installed: ${target}`);

// 3. settings → pixel-office.json (env vars from shells don't reach opencode's background service)
const settings: Record<string, unknown> = {};
if (args.port !== undefined) settings.port = args.port;
if (args.host !== undefined) settings.host = args.host;
if (args.token !== undefined) settings.token = args.token === "auto" ? randomBytes(18).toString("base64url") : args.token;
let current: Record<string, unknown> = {};
try {
  current = JSON.parse(readFileSync(configFile, "utf8"));
} catch {
  // no file yet
}
const merged = { ...current, ...settings };
if (Object.keys(settings).length) {
  mkdirSync(configDir, { recursive: true });
  // the file may hold the access token: readable by you only (mode only applies on macOS/Linux)
  writeFileSync(configFile, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configFile, 0o600);
  ok(`settings saved: ${configFile}`);
}

// 4. sanity checks + next steps
const which = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
if (which.status !== 0) console.log("! opencode was not found on PATH – the plugin becomes active once opencode runs.");

const port = Number(merged.port ?? 4777);
const host = String(merged.host ?? "127.0.0.1");
const shownHost = host === "0.0.0.0" || host === "::" ? "<server-ip>" : host;
const token = typeof merged.token === "string" ? merged.token : undefined;
console.log("");
console.log(`  Pixel Office:  http://${shownHost}:${port}/${token ? `?token=${token}` : ""}`);
console.log("");
console.log("  opencode 2.x reloads the file automatically; with 1.x restart opencode once.");
if ((host === "0.0.0.0" || host === "::") && !token) {
  console.log("  ⚠ Without a token anyone on the network sees prompts, file names and commands – use --token auto.");
}
