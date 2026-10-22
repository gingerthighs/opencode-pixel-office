// opencode plugin entry. One web server per process (singleton); further opencode
// processes on the same host forward their events to it via POST /api/ingest.

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { HTML, JS } from "./assets.generated.ts";
import { loadConfig, type Config } from "./config.ts";
import { Hub } from "./server.ts";
import { Store, type BusEvent } from "./store.ts";

const KEY = Symbol.for("opencode-pixel-office");
const SEED_WINDOW = 2 * 60 * 60 * 1000;
const RETRY_LISTEN_MS = 10_000;

type Client = PluginInput["client"];
type Log = (level: "info" | "warn" | "error", message: string) => void;

class Instance {
  refs = 0;
  private cfg: Config;
  private log: Log;
  private hub?: Hub;
  private queue: BusEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastListenTry = 0;

  constructor(cfg: Config, log: Log) {
    this.cfg = cfg;
    this.log = log;
  }

  get serving() {
    return !!this.hub;
  }

  /** Try to own the port; on EADDRINUSE stay in forwarding mode. */
  async start(): Promise<void> {
    this.lastListenTry = Date.now();
    const hub = new Hub(new Store(), { ...this.cfg, html: HTML, js: JS });
    try {
      await hub.listen();
      this.hub = hub;
      const shown = this.cfg.host === "0.0.0.0" || this.cfg.host === "::" ? "<server-ip>" : this.cfg.host;
      this.log("info", `Pixel Office läuft: http://${shown}:${this.cfg.port}/${this.cfg.token ? "?token=…" : ""}`);
      if (!this.cfg.token && this.cfg.host !== "127.0.0.1" && this.cfg.host !== "localhost") {
        this.log("warn", "Pixel Office ohne PIXEL_OFFICE_TOKEN auf allen Interfaces erreichbar – nur in vertrauenswürdigen Netzen (LAN/Tailscale) nutzen.");
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
      this.log("info", `Port ${this.cfg.port} belegt – leite Events an bestehendes Pixel Office weiter.`);
    }
  }

  ingest(ev: BusEvent) {
    if (this.hub) return this.hub.ingest(ev);
    this.queue.push(ev);
    if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);
    this.flushTimer ??= setTimeout(() => void this.flush(), 150);
  }

  async seed(client: Client) {
    try {
      const listRes: any = await client.session.list();
      const sessions: any[] = listRes?.data ?? (Array.isArray(listRes) ? listRes : []);
      const statusRes: any = await client.session.status().catch(() => undefined);
      const statuses: Record<string, { type?: string }> = statusRes?.data ?? {};
      const cutoff = Date.now() - SEED_WINDOW;
      sessions.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const keep = new Set<string>();
      for (const s of sessions) {
        const busy = statuses[s.id]?.type === "busy";
        if (!s.parentID && (s.time?.updated ?? 0) > cutoff) keep.add(s.id);
        // running subagents (plus their ancestors) are shown even in older rooms
        if (s.parentID && busy) {
          for (let cur: any = s; cur; cur = cur.parentID ? byId.get(cur.parentID) : undefined) keep.add(cur.id);
        }
      }
      for (const s of sessions) if (keep.has(s.id)) this.ingest({ type: "session.updated", properties: { info: s } });
      for (const [id, status] of Object.entries(statuses)) {
        if (keep.has(id)) this.ingest({ type: "session.status", properties: { sessionID: id, status } });
      }
    } catch (err) {
      this.log("warn", `Pixel Office: Session-Snapshot fehlgeschlagen: ${String(err)}`);
    }
  }

  async close() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.hub?.close();
    this.hub = undefined;
  }

  private async flush() {
    this.flushTimer = undefined;
    const events = this.queue.splice(0);
    if (!events.length) return;
    try {
      const res = await fetch(`http://127.0.0.1:${this.cfg.port}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(`ingest ${res.status}`);
    } catch {
      // owner process is gone → try to take over the port
      if (Date.now() - this.lastListenTry > RETRY_LISTEN_MS) {
        await this.start().catch(() => {});
        if (this.hub) for (const ev of events) this.hub.ingest(ev);
      }
    }
  }
}

const server: Plugin = async (input, options) => {
  const { client } = input;
  const log: Log = (level, message) => {
    client.app.log({ body: { service: "pixel-office", level, message } }).catch(() => console.error(message));
  };

  const g = globalThis as unknown as Record<symbol, Promise<Instance> | undefined>;
  g[KEY] ??= (async () => {
    const inst = new Instance(loadConfig(options ?? {}), log);
    await inst.start();
    return inst;
  })();

  let inst: Instance;
  try {
    inst = await g[KEY]!;
  } catch (err) {
    g[KEY] = undefined;
    log("error", `Pixel Office konnte nicht starten: ${String(err)}`);
    return {};
  }
  inst.refs++;
  void inst.seed(client);

  return {
    event: async ({ event }) => {
      inst.ingest(event as BusEvent);
    },
    dispose: async () => {
      if (--inst.refs > 0) return;
      g[KEY] = undefined;
      await inst.close();
    },
  };
};

export default { id: "opencode-pixel-office", server };
