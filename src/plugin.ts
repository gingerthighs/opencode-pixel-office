// opencode plugin entry. One web server per process (singleton); further opencode
// processes on the same host forward their events to it via POST /api/ingest.

import type { Plugin } from "@opencode-ai/plugin";
import { HTML, JS } from "./assets.generated.ts";
import { loadConfig } from "./config.ts";
import { Instance, type Log, type Sink } from "./instance.ts";
import type { BusEvent } from "./store.ts";
import { sample, setSampling, toolEvent, V2Mapper } from "./v2.ts";

const KEY = Symbol.for("opencode-pixel-office");
const SEED_WINDOW = 2 * 60 * 60 * 1000;

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
      const cfg = loadConfig(options);
      setSampling(cfg.debug);
      const inst = new Instance(cfg, log, { html: HTML, js: JS });
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
    log("error", `Pixel Office could not start: ${String(err)}`);
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
  const c = client as any;
  const source = inst.addController(async (req) => {
    if (req.action === "interrupt") {
      checkControlResult(await c.session.abort({ path: { id: req.sessionID }, throwOnError: true }));
    } else if (typeof c.permission?.reply === "function") {
      checkControlResult(await c.permission.reply({ sessionID: req.sessionID, requestID: req.requestID, reply: req.decision }, { throwOnError: true }));
    } else {
      checkControlResult(await c.postSessionIdPermissionsPermissionId({ path: { id: req.sessionID, permissionID: req.requestID }, body: { response: req.decision }, throwOnError: true }));
    }
  });
  void inst.seed(client, source.ingest);
  return {
    event: async ({ event }) => {
      source.ingest(event as BusEvent);
    },
    dispose: async () => {
      source.dispose();
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
  const source = inst.addController(async (req) => {
    if (req.action === "interrupt") {
      if (typeof ctx.session?.interrupt !== "function") throw new Error("session.interrupt is not available");
      checkControlResult(await ctx.session.interrupt({ sessionID: req.sessionID, resume: false }));
    } else {
      if (typeof ctx.permission?.reply !== "function") throw new Error("permission.reply is not available");
      checkControlResult(await ctx.permission.reply({ sessionID: req.sessionID, requestID: req.requestID, decision: req.decision }));
    }
  });
  disposers.push(source.dispose);

  for (const phase of ["before", "after"] as const) {
    try {
      const reg = await ctx.tool?.hook?.(`execute.${phase}`, async (e: unknown) => {
        sample(`tool.execute.${phase}`, e);
        const ev = toolEvent(e as Record<string, unknown>, phase);
        if (ev) source.ingest(ev);
      });
      if (reg?.dispose) disposers.push(() => reg.dispose());
    } catch (err) {
      log("warn", `tool.hook(${phase}) not available: ${String(err)}`);
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
        if (s?.id) source.ingest({ type: "session.updated", properties: { info: { ...s, directory: s.directory ?? s.location?.directory } } });
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
          source.ingest(mapped);
        }
      }
    } catch (err) {
      log("warn", `event stream ended: ${String(err)}`);
    }
  })();

  void seedV2(ctx, source.ingest);

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

async function seedV2(ctx: any, ingest: Sink) {
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
      ingest({ type: "session.updated", properties: { info: { ...s, directory: s.directory ?? s.location?.directory } } });
      if (running) ingest({ type: "session.status", properties: { sessionID: s.id, status: { type: "busy" } } });
    }
  } catch {
    // seeding is best effort
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function checkControlResult(result: unknown) {
  // Some host APIs return error envelopes even when throwOnError is requested.
  if (!isRec(result)) return;
  const responseFailed = isRec(result.response) && result.response.ok === false;
  if (result.error != null || responseFailed) {
    throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? "control failed"));
  }
}

export default { id: "opencode-pixel-office", server, setup };
