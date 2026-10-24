import type { PluginInput } from "@opencode-ai/plugin";
import type { Config } from "./config.ts";
import { ControlRelay, Hub, INGEST_HEADER, type Controller, type Forwarder } from "./server.ts";
import { Store, type BusEvent } from "./store.ts";
import type { ControlRequest } from "./types.ts";

type Client = PluginInput["client"];
export type Log = (level: "info" | "warn" | "error", message: string) => void;
export type Sink = (event: BusEvent) => void;
const SEED_WINDOW = 2 * 60 * 60 * 1000;
const RETRY_LISTEN_MS = 10_000;

export class Instance {
  refs = 0;
  private cfg: Config;
  private log: Log;
  private hub?: Hub;
  private queue: BusEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastListenTry = 0;
  private routes = new Map<string, Controller | Forwarder>();
  private assets: { html: string; js: string };
  private relay?: ControlRelay;
  private owner?: Forwarder;
  private flushing?: Promise<void>;
  private request?: AbortController;
  private closed = false;
  private retryDelay = 500;
  private ownershipVersion = 0;
  private sentVersion = -1;

  constructor(cfg: Config, log: Log, assets: { html: string; js: string }) {
    this.cfg = cfg;
    this.log = log;
    this.assets = assets;
  }

  get serving() {
    return !!this.hub;
  }

  get port() {
    return this.hub?.port ?? this.cfg.port;
  }

  /** Try to own the port; on EADDRINUSE stay in forwarding mode. */
  async start(): Promise<void> {
    if (this.closed || this.hub) return;
    this.lastListenTry = Date.now();
    const hub = new Hub(new Store(), {
      ...this.cfg, ...this.assets,
      onForward: (owner, sessions) => {
        // A batch contains the sender's complete current ownership list.
        for (const [id, route] of this.routes) {
          if (typeof route !== "function" && route.id === owner.id) this.routes.delete(id);
        }
        for (const id of sessions) {
          if (typeof this.routes.get(id) !== "function") this.routes.set(id, owner);
        }
      },
    });
    try {
      await hub.listen();
      if (this.closed) {
        await hub.close();
        return;
      }
      this.hub = hub;
      for (const ev of this.queue.splice(0)) hub.ingest(ev);
      hub.setController((req) => this.dispatch(req));
      const shown = this.cfg.host === "0.0.0.0" || this.cfg.host === "::" ? "<server-ip>" : this.cfg.host;
      this.log("info", `Pixel Office running: http://${shown}:${this.cfg.port}/${this.cfg.token ? "?token=…" : ""}`);
      if (!this.cfg.token && this.cfg.host !== "127.0.0.1" && this.cfg.host !== "localhost") {
        this.log("warn", "Pixel Office is reachable on all interfaces without PIXEL_OFFICE_TOKEN – only use this on trusted networks (LAN/Tailscale).");
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
      this.log("info", `Port ${this.cfg.port} is taken – forwarding events to the running Pixel Office.`);
    }
  }

  /** Events and their controller stay together, including snapshots and async lookups. */
  addController(c: Controller): { ingest: Sink; dispose: () => void } {
    let active = true;
    return {
      ingest: (ev) => {
        if (!active || this.closed) return;
        const p = ev?.properties ?? {};
        const id = typeof ev?.type === "string" && ev.type.startsWith("session.") && p.info?.id
          ? p.info.id : p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
        if (typeof id === "string") {
          this.ownershipVersion++;
          if (ev.type === "session.deleted") this.routes.delete(id);
          else this.routes.set(id, c);
        }
        this.ingest(ev);
      },
      dispose: () => {
        active = false;
        for (const [id, route] of this.routes) if (route === c) this.routes.delete(id);
        this.ownershipVersion++;
        // Send the updated ownership list even if there are no more events.
        this.schedule(0);
      },
    };
  }

  private async dispatch(req: ControlRequest, localOnly = false) {
    const route = this.routes.get(req.sessionID);
    if (!route || (localOnly && typeof route !== "function")) throw new Error("session owner unavailable");
    if (typeof route === "function") return route(req);
    const res = await fetch(`http://127.0.0.1:${route.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", [INGEST_HEADER]: "control", authorization: `Bearer ${route.token}` },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error((await res.text()) || `control ${res.status}`);
    await res.arrayBuffer();
  }

  private ingest(ev: BusEvent) {
    if (this.closed) return;
    if (this.hub) return this.hub.ingest(ev);
    this.queue.push(ev);
    this.trimQueue();
    this.schedule(150);
  }

  private trimQueue() {
    if (this.queue.length > 5000) {
      this.queue.splice(0, this.queue.length - 5000);
      this.log("warn", "Pixel Office forwarding backlog exceeded 5000 events; oldest events dropped.");
    }
  }

  async seed(client: Client, ingest: Sink) {
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
      for (const s of sessions) if (keep.has(s.id)) ingest({ type: "session.updated", properties: { info: s } });
      for (const [id, status] of Object.entries(statuses)) {
        if (keep.has(id)) ingest({ type: "session.status", properties: { sessionID: id, status } });
      }
    } catch (err) {
      this.log("warn", `Pixel Office: session snapshot failed: ${String(err)}`);
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.request?.abort();
    await this.flushing;
    await this.relay?.close();
    await this.hub?.close();
    this.hub = undefined;
    this.routes.clear();
    this.queue = [];
  }

  private schedule(delay: number) {
    if (this.closed || this.hub || this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => void this.flush(), delay);
    this.flushTimer.unref?.();
  }

  /** Single-flight delivery keeps retries ahead of events arriving during the request. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushing = this.deliver().finally(() => {
      this.flushing = undefined;
      this.request = undefined;
      if (this.queue.length || this.sentVersion !== this.ownershipVersion) this.schedule(this.retryDelay);
    });
    return this.flushing;
  }

  private async deliver() {
    const events = this.queue.splice(0);
    if (this.hub) {
      for (const ev of events) this.hub.ingest(ev);
      return;
    }
    try {
      if (!this.owner) {
        this.relay = new ControlRelay((req) => this.dispatch(req, true));
        this.owner = await this.relay.listen();
      }
      if (this.closed) return;
      this.request = new AbortController();
      const version = this.ownershipVersion;
      const host = this.cfg.host === "0.0.0.0" ? "127.0.0.1" : this.cfg.host === "::" ? "[::1]" : this.cfg.host;
      const target = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const res = await fetch(`http://${target}:${this.cfg.port}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INGEST_HEADER]: "ingest",
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify({ events, owner: this.owner, sessions: [...this.routes].filter(([, r]) => typeof r === "function").map(([id]) => id) }),
        signal: AbortSignal.any([this.request.signal, AbortSignal.timeout(5000)]),
      });
      if (!res.ok) throw new Error(`ingest ${res.status}`);
      await res.arrayBuffer();
      this.sentVersion = version;
      this.retryDelay = 500;
    } catch {
      if (this.closed) return;
      this.queue.unshift(...events);
      this.trimQueue();
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
      // owner process is gone → try to take over the port
      if (Date.now() - this.lastListenTry > RETRY_LISTEN_MS) {
        await this.start().catch(() => {});
      }
    }
  }
}
