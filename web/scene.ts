// Canvas renderer: office + characters + paper planes + bubbles for the selected room.

import type { Agent } from "../src/types.ts";
import { bubbleFor, drawBubble, drawNameTag, FONT } from "./bubbles.ts";
import { Char } from "./characters.ts";
import { H, Office, W, ZONES, type Dyn, type SeatState } from "./office.ts";
import { STATUS_COLOR } from "./roles.ts";
import { paperPlane, T } from "./sprites.ts";
import type { ClientState } from "./state.ts";

interface Plane {
  from: string;
  to: string;
  t0: number;
  sx: number;
  sy: number;
}

export class Scene {
  roomId?: string;
  selected?: string;
  onSelect?: (id: string | undefined) => void;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private state: ClientState;
  private office = new Office();
  private chars = new Map<string, Char>();
  private planes: Plane[] = [];
  private pendingPlanes: { from: string; to: string; at: number }[] = [];
  private teleport = true;
  private last = performance.now();
  private view = { s: 1, ox: 0, oy: 0, cw: 0, ch: 0 };

  constructor(canvas: HTMLCanvasElement, state: ClientState) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.state = state;
    state.onDelegate = (from, to) => this.pendingPlanes.push({ from, to, at: performance.now() });
    canvas.addEventListener("click", (e) => this.click(e));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  setRoom(id: string | undefined) {
    if (id === this.roomId) return;
    this.roomId = id;
    this.reset();
  }

  /** Rebuild characters without walk-in animation (room switch / reconnect). */
  reset() {
    this.office = new Office();
    this.chars.clear();
    this.planes = [];
    this.pendingPlanes = [];
    this.teleport = true;
  }

  private resize() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(box.width * dpr));
    this.canvas.height = Math.max(1, Math.round(box.height * dpr));
    this.canvas.style.width = box.width + "px";
    this.canvas.style.height = box.height + "px";
    const fit = Math.min(box.width / (W * T), box.height / (H * T));
    // snap to whole device pixels per world pixel once big enough; below that, filling the space matters more
    const s = fit * dpr >= 3 ? Math.floor(fit * dpr) / dpr : fit;
    this.view = {
      s,
      ox: Math.round(((box.width - W * T * s) / 2) * dpr) / dpr,
      oy: Math.round(((box.height - H * T * s) / 2) * dpr) / dpr,
      cw: box.width,
      ch: box.height,
    };
  }

  private toWorld(cx: number, cy: number) {
    return { x: (cx - this.view.ox) / this.view.s, y: (cy - this.view.oy) / this.view.s };
  }

  private toScreen(wx: number, wy: number) {
    return { x: this.view.ox + wx * this.view.s, y: this.view.oy + wy * this.view.s };
  }

  private click(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const p = this.toWorld(e.clientX - r.left, e.clientY - r.top);
    const hits = [...this.chars.values()].filter((c) => !c.gone && c.hit(p.x, p.y)).sort((a, b) => b.y - a.y);
    this.onSelect?.(hits[0]?.id);
  }

  private sync(now: number) {
    const roomId = this.roomId;
    const agents = roomId ? this.state.roomAgents(roomId) : [];
    for (const a of agents) {
      if (this.chars.has(a.id)) continue;
      if (a.status === "done") continue;
      this.chars.set(a.id, new Char(a, this.office, !this.teleport, now));
    }
    this.teleport = false;
    for (const [id, c] of this.chars) if (c.gone) this.chars.delete(id);

    // launch planes once both ends exist
    const t = performance.now();
    this.pendingPlanes = this.pendingPlanes.filter((p) => {
      const from = this.chars.get(p.from);
      const to = this.chars.get(p.to);
      if (from && to) {
        this.planes.push({ from: p.from, to: p.to, t0: t, sx: from.x, sy: from.headY });
        return false;
      }
      return t - p.at < 3000;
    });
  }

  private dyn(): Dyn {
    const seats = new Map<string, SeatState>();
    let bash = false;
    let oracleBusy = false;
    let lounge = false;
    let todos: Agent["todos"] = [];
    for (const c of this.chars.values()) {
      const a = this.state.agents.get(c.id);
      if (!a) continue;
      if (!a.parentId) todos = a.todos;
      const busy = a.status === "busy" || a.status === "retry";
      if (busy && a.tool?.state === "running" && /bash|shell|exec|pty/.test(a.tool.name)) bash = true;
      if (c.seat && c.goal === "seat" && c.arrived) {
        seats.set(c.seat.id, { status: a.status, waiting: a.waiting, tool: a.tool?.state === "running" ? a.tool.name : undefined });
        if (c.seat.zone === "oracle" && busy) oracleBusy = true;
      }
      if (c.goal === "lounge") lounge = true;
    }
    return { seats, todos, bash, oracleBusy, lounge };
  }

  private frame(ts: number) {
    // background tabs pause rAF; after a long gap, snap everyone into place instead of replaying walks
    if (ts - this.last > 1500) this.reset();
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    const now = Date.now();
    const t = ts / 1000;
    this.sync(now);
    for (const c of this.chars.values()) c.update(dt, this.state.agents.get(c.id), this.office, now);
    this.draw(t);
    requestAnimationFrame((n) => this.frame(n));
  }

  private draw(t: number) {
    const g = this.g;
    const dpr = devicePixelRatio || 1;
    const { s, ox, oy, cw, ch } = this.view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#100d18";
    g.fillRect(0, 0, cw, ch);

    g.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.office.bg, 0, 0);
    this.office.drawDynamic(g, t, this.dyn());

    const chars = [...this.chars.values()].sort((a, b) => a.y - b.y);
    for (const c of chars) c.draw(g, t, this.state.agents.get(c.id), this.office, c.id === this.selected);

    // paper planes
    const plane = paperPlane();
    this.planes = this.planes.filter((p) => {
      const to = this.chars.get(p.to);
      const k = (performance.now() - p.t0) / 1100;
      if (!to || k >= 1) return false;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = p.sx + (to.x - p.sx) * e;
      const y = p.sy + (to.headY - p.sy) * e - Math.sin(Math.PI * k) * 24;
      g.drawImage(plane, Math.round(x) - 4, Math.round(y) - 3);
      return true;
    });

    // screen-space overlay
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(g);
    if (!this.roomId) return this.empty(g, "Noch keine Session – starte etwas in opencode.");
    if (!chars.length) this.empty(g, "Raum leer");

    const tagScale = Math.max(1, s);
    for (const c of chars) {
      const a = this.state.agents.get(c.id);
      if (!a || c.alpha < 0.5) continue;
      const feet = this.toScreen(c.x, c.y);
      const color = a.waiting ? STATUS_COLOR.waiting : STATUS_COLOR[a.status];
      drawNameTag(g, feet.x, feet.y + 3 * tagScale, a.name, color);
    }
    // bubbles last; selected on top
    const ordered = chars.filter((c) => c.id !== this.selected);
    const sel = chars.find((c) => c.id === this.selected);
    if (sel) ordered.push(sel);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const c of ordered) {
      const a = this.state.agents.get(c.id);
      if (!a || c.alpha < 0.5) continue;
      const b = bubbleFor(a, this.state, c.id === this.selected);
      if (!b) continue;
      const head = this.toScreen(c.x, c.headY - 2);
      let y = head.y;
      // nudge upward to avoid overlapping earlier bubbles
      for (let i = 0; i < 4; i++) {
        const clash = placed.find((r) => Math.abs(r.x + r.w / 2 - head.x) < (r.w + 120) / 2 && y > r.y && y - 34 < r.y + r.h);
        if (!clash) break;
        y = clash.y - 2;
      }
      placed.push(drawBubble(g, head.x, y, b, c.id === this.selected ? 300 : 210));
    }
  }

  private drawLabels(g: CanvasRenderingContext2D) {
    const s = this.view.s;
    if (s < 1) return;
    g.font = `${Math.round(Math.min(13, 8 + s * 1.5))}px ${FONT}`;
    g.textBaseline = "top";
    for (const z of ZONES) {
      const p = this.toScreen(z.x * T + 5, z.y * T + 4);
      g.globalAlpha = 0.55;
      g.fillStyle = "#f1ecff";
      g.fillText(z.label.toUpperCase(), p.x, p.y);
    }
    g.globalAlpha = 1;
  }

  private empty(g: CanvasRenderingContext2D, msg: string) {
    g.font = `16px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const { cw, ch } = this.view;
    g.fillStyle = "rgba(16,13,24,0.75)";
    const w = g.measureText(msg).width + 30;
    g.fillRect(cw / 2 - w / 2, ch / 2 - 18, w, 36);
    g.fillStyle = "#e9e4ff";
    g.fillText(msg, cw / 2, ch / 2);
    g.textAlign = "start";
  }
}
