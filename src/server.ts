// HTTP + SSE server. Uses node:http so it runs inside opencode (Bun) and under plain Node (mock/dev).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BusEvent, Store } from "./store.ts";
import type { ControlRequest, Op } from "./types.ts";

export type Controller = (req: ControlRequest) => Promise<void>;

export interface HubOptions {
  port: number;
  host: string;
  token?: string;
  html: string;
  js: string;
}

const COOKIE = "po_token";
const MAX_BODY = 5 * 1024 * 1024;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

const isLoopback = (addr?: string) => !!addr && (addr === "::1" || addr.startsWith("127.") || addr === "::ffff:127.0.0.1");

export class Hub {
  readonly store: Store;
  private opts: HubOptions;
  private clients = new Set<ServerResponse>();
  private server?: Server;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** per-process secret embedded in the page; control requests must echo it (blocks cross-site POSTs) */
  private nonce = randomBytes(16).toString("hex");
  private controller?: Controller;

  constructor(store: Store, opts: HubOptions) {
    this.store = store;
    this.opts = opts;
  }

  setController(c: Controller | undefined) {
    this.controller = c;
  }

  /**
   * Writes from the UI (permission replies, stop) are allowed with a token, or without one only when
   * the server listens on loopback and the request names a loopback host (no DNS rebinding).
   */
  private controlAllowed(req: IncomingMessage): { ok: boolean; reason?: string } {
    if (!this.controller) return { ok: false, reason: "Host-API ohne Steuerung" };
    if (this.opts.token) return { ok: true };
    const loopbackBind = this.opts.host === "127.0.0.1" || this.opts.host === "localhost" || this.opts.host === "::1";
    if (!loopbackBind) return { ok: false, reason: "PIXEL_OFFICE_TOKEN setzen, um im Netz zu steuern" };
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return { ok: false, reason: "nur über localhost" };
    return { ok: true };
  }

  get clientCount() {
    return this.clients.size;
  }

  ingest(ev: BusEvent) {
    this.broadcast(this.store.apply(ev));
  }

  broadcast(ops: Op[]) {
    if (!ops.length || !this.clients.size) return;
    const msg = `event: ops\ndata: ${JSON.stringify(ops)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off("error", reject);
        server.on("error", () => {});
        this.server = server;
        this.timers.push(
          setInterval(() => this.broadcast(this.store.tick()), 250),
          setInterval(() => {
            for (const c of this.clients) c.write(": ping\n\n");
          }, 15_000),
        );
        for (const t of this.timers) (t as { unref?: () => void }).unref?.();
        resolve();
      });
    });
  }

  async close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.clients) c.end();
    this.clients.clear();
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const token = this.opts.token;
    if (!token) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const given = url.searchParams.get("token") ?? bearer ?? readCookie(req, COOKIE);
    return !!given && safeEqual(given, token);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/control" && req.method === "POST") {
      if (!this.authorized(req, url)) return this.send(res, 401, "text/plain", "unauthorized");
      const nonce = req.headers["x-po-nonce"];
      if (typeof nonce !== "string" || !safeEqual(nonce, this.nonce)) return this.send(res, 403, "text/plain", "bad nonce");
      const allowed = this.controlAllowed(req);
      if (!allowed.ok) return this.send(res, 403, "text/plain", allowed.reason ?? "forbidden");
      const body = JSON.parse((await readBody(req)) || "{}") as ControlRequest;
      if (!body || typeof body.sessionID !== "string" || !["permission", "interrupt"].includes(body.action)) {
        return this.send(res, 400, "text/plain", "bad request");
      }
      if (body.action === "permission" && (typeof body.requestID !== "string" || !["once", "always", "reject"].includes(body.decision))) {
        return this.send(res, 400, "text/plain", "bad request");
      }
      try {
        await this.controller!(body);
        return this.send(res, 200, "application/json", JSON.stringify({ ok: true }));
      } catch (err) {
        return this.send(res, 502, "application/json", JSON.stringify({ ok: false, error: String(err) }));
      }
    }

    if (path === "/api/ingest" && req.method === "POST") {
      // without a token, only same-host opencode processes may push events
      const ok = this.opts.token ? this.authorized(req, url) : isLoopback(req.socket.remoteAddress);
      if (!ok) return this.send(res, 401, "text/plain", "unauthorized");
      const body = await readBody(req);
      const events: BusEvent[] = JSON.parse(body || "{}").events ?? [];
      for (const ev of events) this.ingest(ev);
      return this.send(res, 204, "text/plain", "");
    }

    if (!this.authorized(req, url)) {
      return this.send(res, 401, "text/html; charset=utf-8", UNAUTHORIZED_PAGE);
    }

    // first visit with ?token=… → remember it in a cookie and drop it from the URL
    if (this.opts.token && url.searchParams.has("token") && req.method === "GET") {
      url.searchParams.delete("token");
      const q = url.searchParams.toString();
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        "set-cookie": `${COOKIE}=${encodeURIComponent(this.opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        location: (req.url ?? "/").split("?")[0] + (q ? "?" + q : ""),
      });
      return res.end();
    }

    if (req.method !== "GET") return this.send(res, 405, "text/plain", "method not allowed");

    switch (path) {
      case "/":
      case "/index.html":
        return this.send(res, 200, "text/html; charset=utf-8", this.opts.html.replace("</head>", `<meta name="po-nonce" content="${this.nonce}" /></head>`), {
          "content-security-policy": CSP,
        });
      case "/app.js":
        return this.send(res, 200, "text/javascript; charset=utf-8", this.opts.js);
      case "/api/caps": {
        const c = this.controlAllowed(req);
        return this.send(res, 200, "application/json", JSON.stringify({ control: c.ok, reason: c.reason }));
      }
      case "/api/state":
        return this.send(res, 200, "application/json", JSON.stringify(this.store.snapshot()));
      case "/api/events":
        return this.stream(req, res);
      case "/healthz":
        return this.send(res, 200, "text/plain", "ok");
    }
    return this.send(res, 404, "text/plain", "not found");
  }

  private stream(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n\nevent: snapshot\ndata: ${JSON.stringify(this.store.snapshot())}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const UNAUTHORIZED_PAGE = `<!doctype html><meta charset="utf-8"><title>Pixel Office</title>
<body style="background:#16121f;color:#e9e4ff;font:16px monospace;display:grid;place-items:center;height:100vh;margin:0">
<div>🔒 Token fehlt. Öffne die URL mit <code>?token=…</code> (PIXEL_OFFICE_TOKEN).</div></body>`;
