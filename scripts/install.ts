// Cross-platform installer: builds the plugin and drops it into opencode's plugin folder.
// Run through install.sh / install.ps1, or directly: node scripts/install.ts [options]

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      if (v === undefined) fail(`--${k} braucht einen Wert`);
      return v;
    };
    switch (k) {
      case "project":
        a.project = next();
        break;
      case "port": {
        const p = Number(next());
        if (!Number.isInteger(p) || p < 1 || p > 65535) fail("--port muss zwischen 1 und 65535 liegen");
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
        fail(`Unbekannte Option: ${argv[i]}\n\n${HELP}`);
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
    ok(`entfernt: ${target}`);
  } else {
    console.log(`– nichts zu entfernen in ${pluginDir}`);
  }
  if (args.purge && existsSync(configFile)) {
    rmSync(configFile);
    ok(`entfernt: ${configFile}`);
  }
  console.log("opencode lädt Plugins beim nächsten Start neu (2.x merkt das Löschen auch im laufenden Betrieb).");
  process.exit(0);
}

// 1. build
const dist = join(ROOT, "dist", PLUGIN);
if (!args.skipBuild) {
  if (!existsSync(join(ROOT, "node_modules", "esbuild"))) {
    step("installiere Build-Abhängigkeiten (npm ci)");
    // npm is a .cmd shim on Windows, which only runs through a shell
    run("npm", existsSync(join(ROOT, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], process.platform === "win32");
  }
  step("baue dist/" + PLUGIN);
  run(process.execPath, ["build.ts"]);
}
if (!existsSync(dist)) fail(`dist/${PLUGIN} fehlt – ohne --skip-build erneut ausführen`);

// 2. install
mkdirSync(pluginDir, { recursive: true });
copyFileSync(dist, target);
ok(`Plugin installiert: ${target}`);

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
  writeFileSync(configFile, JSON.stringify(merged, null, 2) + "\n");
  ok(`Einstellungen gespeichert: ${configFile}`);
}

// 4. sanity checks + next steps
const which = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
if (which.status !== 0) console.log("! opencode wurde nicht im PATH gefunden – das Plugin wird aktiv, sobald opencode läuft.");

const port = Number(merged.port ?? 4777);
const host = String(merged.host ?? "127.0.0.1");
const shownHost = host === "0.0.0.0" || host === "::" ? "<server-ip>" : host;
const token = typeof merged.token === "string" ? merged.token : undefined;
console.log("");
console.log(`  Pixel Office:  http://${shownHost}:${port}/${token ? `?token=${token}` : ""}`);
console.log("");
console.log("  opencode 2.x lädt die Datei automatisch neu; bei 1.x opencode einmal neu starten.");
if ((host === "0.0.0.0" || host === "::") && !token) {
  console.log("  ⚠ Ohne Token sieht jeder im Netz Prompts, Dateinamen und Befehle – besser --token auto.");
}
