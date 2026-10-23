import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  token?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** opencode's config dir on every OS: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode */
export function opencodeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return join(str(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config"), "opencode");
}

export const CONFIG_FILE = "pixel-office.json";

/** `<config dir>/pixel-office.json` — written by the installer; missing or broken files are ignored */
export function readConfigFile(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(opencodeConfigDir(env), CONFIG_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Precedence: env vars > plugin options from opencode.json (`["opencode-pixel-office", { port, host, token }]`)
 * > pixel-office.json > defaults. The file exists because env vars set after opencode's background
 * service started never reach it.
 */
export function loadConfig(
  opts: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
  file: Record<string, unknown> = readConfigFile(env),
): Config {
  const port = Number(env.PIXEL_OFFICE_PORT ?? opts.port ?? file.port ?? 4777);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4777,
    host: str(env.PIXEL_OFFICE_HOST) ?? str(opts.host) ?? str(file.host) ?? "127.0.0.1",
    token: str(env.PIXEL_OFFICE_TOKEN) ?? str(opts.token) ?? str(file.token),
  };
}
