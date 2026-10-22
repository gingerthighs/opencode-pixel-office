// opencode plugin entry. One web server per process (singleton); further opencode
// processes on the same host forward their events to it via POST /api/ingest.

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { HTML, JS } from "./assets.generated.ts";
import { loadConfig, type Config } from "./config.ts";
import { Hub, type Controller } from "./server.ts";
import { Store, type BusEvent } from "./store.ts";
import { sample, toolEvent, V2Mapper } from "./v2.ts";

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
  private controllers: Controller[] = [];

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
      hub.setController((req) => this.dispatch(req));
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

  /** register a way to act on sessions (permission reply, interrupt); returns an unregister fn */
  addController(c: Controller): () => void {
    this.controllers.push(c);
    return () => {
      this.controllers = this.controllers.filter((x) => x !== c);
    };
  }

  private async dispatch(req: Parameters<Controller>[0]) {
    const c = this.controllers.at(-1);
    if (!c) throw new Error("keine Steuerung verfügbar");
    await c(req);
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

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";

interface Slot {
  build: string;
  instance: Promise<Instance>;
}
const g = globalThis as unknown as Record<symbol, Slot | undefined>;

async function acquire(options: Record<string, unknown>, log: Log): Promise<Instance | undefined> {
  const prev = g[KEY];
  if (prev && prev.build !== BUILD) {
    // hot reload of a new plugin version: the old module may never get disposed, so retire its server
    // (0.1.0 stored the bare instance promise in the slot)
    g[KEY] = undefined;
    const old: Promise<Instance> | undefined = typeof (prev as any).then === "function" ? (prev as any) : prev.instance;
    await old?.then((i) => i.close()).catch(() => {});
  }
  g[KEY] ??= {
    build: BUILD,
    instance: (async () => {
      const inst = new Instance(loadConfig(options), log);
      await inst.start();
      return inst;
    })(),
  };
  try {
    const inst = await g[KEY]!.instance;
    inst.refs++;
    return inst;
  } catch (err) {
    g[KEY] = undefined;
    log("error", `Pixel Office konnte nicht starten: ${String(err)}`);
  }
}

async function release(inst: Instance) {
  if (--inst.refs > 0) return;
  if (g[KEY]) {
    const current = await g[KEY]!.instance.catch(() => undefined);
    if (current === inst) g[KEY] = undefined;
  }
  await inst.close();
}

/** opencode 1.x host */
const server: Plugin = async (input, options) => {
  const { client } = input;
  const log: Log = (level, message) => {
    client.app.log({ body: { service: "pixel-office", level, message } }).catch(() => console.error(message));
  };
  const inst = await acquire(options ?? {}, log);
  if (!inst) return {};
  void inst.seed(client);
  const c = client as any;
  const unregister = inst.addController(async (req) => {
    if (req.action === "interrupt") {
      await c.session.abort({ path: { id: req.sessionID } });
    } else if (typeof c.permission?.reply === "function") {
      await c.permission.reply({ sessionID: req.sessionID, requestID: req.requestID, reply: req.decision });
    } else {
      await c.postSessionIdPermissionsPermissionId({ path: { id: req.sessionID, permissionID: req.requestID }, body: { response: req.decision } });
    }
  });
  return {
    event: async ({ event }) => {
      inst.ingest(event as BusEvent);
    },
    dispose: async () => {
      unregister();
      await release(inst);
    },
  };
};

/** opencode 2.x host: setup(ctx) → dispose */
const setup = async (ctx: any): Promise<() => Promise<void>> => {
  // the TUI process also loads plugins but has no event stream — only the server hosts the office
  if (typeof ctx?.event?.subscribe !== "function") return async () => {};
  const log: Log = (level, message) => (level === "info" ? console.log : console.error)(`[pixel-office] ${message}`);
  const inst = await acquire(isRec(ctx.options) ? ctx.options : {}, log);
  if (!inst) return async () => {};

  const mapper = new V2Mapper();
  const disposers: (() => unknown)[] = [];
  disposers.push(
    inst.addController(async (req) => {
      if (req.action === "interrupt") {
        if (typeof ctx.session?.interrupt !== "function") throw new Error("session.interrupt fehlt");
        await ctx.session.interrupt({ sessionID: req.sessionID, resume: false });
      } else {
        if (typeof ctx.permission?.reply !== "function") throw new Error("permission.reply fehlt");
        await ctx.permission.reply({ sessionID: req.sessionID, requestID: req.requestID, decision: req.decision });
      }
    }),
  );

  for (const phase of ["before", "after"] as const) {
    try {
      const reg = await ctx.tool?.hook?.(`execute.${phase}`, async (e: unknown) => {
        sample(`tool.execute.${phase}`, e);
        const ev = toolEvent(e as Record<string, unknown>, phase);
        if (ev) inst.ingest(ev);
      });
      if (reg?.dispose) disposers.push(() => reg.dispose());
    } catch (err) {
      log("warn", `tool.hook(${phase}) nicht verfügbar: ${String(err)}`);
    }
  }

  // events can reference sessions we never saw created (e.g. a revived subagent):
  // look them up once so the store learns the parent link and agent
  const known = new Set<string>();
  const lookup = (sid: string | undefined) => {
    if (!sid || known.has(sid) || typeof ctx.session?.get !== "function") return;
    known.add(sid);
    if (known.size > 5000) known.delete(known.values().next().value!);
    Promise.resolve(ctx.session.get({ sessionID: sid }))
      .then((res: any) => {
        const s = res?.data ?? res;
        if (s?.id) inst.ingest({ type: "session.updated", properties: { info: { ...s, directory: s.directory ?? s.location?.directory } } });
      })
      .catch(() => {});
  };

  let stopped = false;
  const iterator = ctx.event.subscribe()[Symbol.asyncIterator]();
  disposers.push(() => {
    stopped = true;
    return iterator.return?.();
  });
  void (async () => {
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done) break;
        const ev = next.value;
        sample(String(ev?.type), ev);
        for (const mapped of mapper.map(ev ?? {})) {
          const p = mapped.properties ?? {};
          if (mapped.type === "session.created" || mapped.type === "session.updated") known.add(p.info?.id);
          else lookup(p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID);
          inst.ingest(mapped);
        }
      }
    } catch (err) {
      log("warn", `Event-Stream beendet: ${String(err)}`);
    }
  })();

  void seedV2(ctx, inst);

  return async () => {
    for (const d of disposers.splice(0)) {
      try {
        await d();
      } catch {
        // ignore
      }
    }
    await release(inst);
  };
};

async function seedV2(ctx: any, inst: Instance) {
  try {
    if (typeof ctx.session?.list !== "function") return;
    const res = await ctx.session.list({});
    const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    sample("session.list[0]", list[0]);
    const now = Date.now();
    for (const s of list.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))) {
      const updated = s.time?.updated ?? s.time?.created ?? 0;
      const idle = s.time?.idle;
      // v2 has no status listing: activity after the last idle mark means a run is in progress
      const running = now - updated < 10 * 60_000 && (idle == null || updated - idle > 5000);
      // roots from the last 2h; children only while they still seem to run
      if (s.parentID ? !running : now - updated > SEED_WINDOW) continue;
      inst.ingest({ type: "session.updated", properties: { info: { ...s, directory: s.directory ?? s.location?.directory } } });
      if (running) inst.ingest({ type: "session.status", properties: { sessionID: s.id, status: { type: "busy" } } });
    }
  } catch {
    // seeding is best effort
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export default { id: "opencode-pixel-office", server, setup };
