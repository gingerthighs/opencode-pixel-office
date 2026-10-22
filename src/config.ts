export interface Config {
  port: number;
  host: string;
  token?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Env vars win over plugin options from opencode.json (`["opencode-pixel-office", { port, host, token }]`). */
export function loadConfig(opts: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PIXEL_OFFICE_PORT ?? opts.port ?? 4777);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4777,
    host: str(env.PIXEL_OFFICE_HOST) ?? str(opts.host) ?? "127.0.0.1",
    token: str(env.PIXEL_OFFICE_TOKEN) ?? str(opts.token),
  };
}
