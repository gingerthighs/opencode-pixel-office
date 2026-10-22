// Canvas renderer: office + characters + cat + paper planes + night lighting + screen-space overlays.

import type { Agent } from "../src/types.ts";
import { bubbleFor, drawBubble, drawNameTag, FONT, measureBubble, measureTag, overlaps, TAG_H, type Box, type MeasuredBubble } from "./bubbles.ts";
import { Cat, Char } from "./characters.ts";
import { daylight, H, Office, SIGN_BG, SIGN_RIM, SIGN_TEXT, W, ZONES, type Dyn, type SeatState } from "./office.ts";
import { STATUS_COLOR } from "./roles.ts";
import { makeCanvas, paperPlane, T } from "./sprites.ts";
import type { ClientState } from "./state.ts";

interface Plane {
  from: string;
  to: string;
  t0: number;
  sx: number;
  sy: number;
}

const LIGHT_RES = 4; // world px per light-map cell → chunky, pixel-style light pools

export class Scene {
  roomId?: string;
  selected?: string;
  onSelect?: (id: string | undefined) => void;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private state: ClientState;
  private office = new Office();
  private chars = new Map<string, Char>();
  private cat = new Cat(this.office);
  private planes: Plane[] = [];
  private pendingPlanes: { from: string; to: string; at: number }[] = [];
  private teleport = true;
  private last = performance.now();
  private hovered?: string;
  /** screen rects of the zone signs this frame — overlays try to keep them readable */
  private signBoxes: Box[] = [];
  private view = { s: 1, ox: 0, oy: 0, cw: 0, ch: 0 };
  private dark = makeCanvas((W * T) / LIGHT_RES, (H * T) / LIGHT_RES);
  private tint = makeCanvas((W * T) / LIGHT_RES, (H * T) / LIGHT_RES);
  private day = 1;
  private dayCheckedAt = -Infinity;

  constructor(canvas: HTMLCanvasElement, state: ClientState) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.state = state;
    state.onDelegate = (from, to) => this.pendingPlanes.push({ from, to, at: performance.now() });
    canvas.addEventListener("click", (e) => this.onSelect?.(this.hit(e)));
    canvas.addEventListener("mousemove", (e) => {
      this.hovered = this.hit(e);
      canvas.style.cursor = this.hovered ? "pointer" : "default";
    });
    canvas.addEventListener("mouseleave", () => (this.hovered = undefined));
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
    this.cat = new Cat(this.office);
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

  private hit(e: MouseEvent): string | undefined {
    const r = this.canvas.getBoundingClientRect();
    const p = this.toWorld(e.clientX - r.left, e.clientY - r.top);
    const hits = [...this.chars.values()].filter((c) => !c.gone && c.hit(p.x, p.y)).sort((a, b) => b.y - a.y);
    return hits[0]?.id;
  }

  private sync(now: number) {
    const agents = this.roomId ? this.state.roomAgents(this.roomId) : [];
    for (const a of agents) {
      if (this.chars.has(a.id) || a.status === "done") continue;
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
    let active = 0;
    let tokens = 0;
    let todos: Agent["todos"] = [];
    for (const c of this.chars.values()) {
      const a = this.state.agents.get(c.id);
      if (!a) continue;
      if (!a.parentId) todos = a.todos;
      tokens += a.tokens;
      const busy = a.status === "busy" || a.status === "retry";
      if (busy) active++;
      if (busy && a.tool?.state === "running" && /bash|shell|exec|pty/.test(a.tool.name)) bash = true;
      if (c.seat && c.goal === "seat" && c.arrived) {
        seats.set(c.seat.id, { status: a.status, waiting: a.waiting, tool: a.tool?.state === "running" ? a.tool.name : undefined });
        if (c.seat.zone === "oracle" && busy) oracleBusy = true;
      }
      if (c.goal === "lounge") lounge = true;
    }
    return { seats, todos, bash, oracleBusy, lounge, active, tokens, daylight: this.day };
  }

  private frame(ts: number) {
    // background tabs pause rAF; after a long gap, snap everyone into place instead of replaying walks
    if (ts - this.last > 1500) this.reset();
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    const now = Date.now();
    if (now - this.dayCheckedAt > 30_000) {
      const forced = new URLSearchParams(location.search).get("time");
      this.day = forced === "night" ? 0 : forced === "day" ? 1 : daylight();
      this.dayCheckedAt = now;
    }
    this.sync(now);
    for (const c of this.chars.values()) c.update(dt, this.state.agents.get(c.id), this.office, now);
    this.cat.update(dt, this.office, performance.now());
    this.draw(ts / 1000);
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
    const dyn = this.dyn();
    this.office.drawDynamic(g, t, dyn);
    this.signs(g, dpr);

    // y-sorted actors (people + cat)
    const chars = [...this.chars.values()].sort((a, b) => a.y - b.y);
    const actors: { y: number; draw: () => void }[] = chars.map((c) => ({
      y: c.y,
      draw: () => c.draw(g, t, this.state.agents.get(c.id), this.office, c.id === this.selected),
    }));
    actors.push({ y: this.cat.y, draw: () => this.cat.draw(g, t) });
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());

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

    this.lighting(g, dyn, t);

    // screen-space overlay
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.roomId) return this.empty(g, "Noch keine Session – starte etwas in opencode.");
    if (!chars.length) this.empty(g, "Raum leer");
    this.overlays(g, chars);
  }

  /**
   * Zone signs sit on the floor and must stay under the characters. Zoomed in, the 3×5 pixel font is
   * crisp; zoomed out it would smear, so the plaques are drawn in screen space with the UI font instead
   * (still before the characters, so people walk over them).
   */
  private signs(g: CanvasRenderingContext2D, dpr: number) {
    const { s, ox, oy } = this.view;
    this.signBoxes = [];
    if (s * dpr >= 2) {
      g.drawImage(this.office.signLayer, 0, 0);
      for (const z of ZONES) {
        const w = (z.label.length * 4 + 7) * s;
        const p = this.toScreen(z.sign.x, z.sign.y);
        this.signBoxes.push({ x: p.x - w / 2, y: p.y, w, h: 10 * s });
      }
      return;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fs = Math.max(9, Math.round(8 * s + 1));
    g.font = `600 ${fs}px ${FONT}`;
    g.textBaseline = "middle";
    for (const z of ZONES) {
      const p = this.toScreen(z.sign.x, z.sign.y);
      const w = Math.ceil(g.measureText(z.label).width) + 10;
      const h = fs + 5;
      const x = Math.round(p.x - w / 2);
      const y = Math.round(p.y);
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(x + 2, y + 2, w, h);
      g.fillStyle = SIGN_RIM;
      g.fillRect(x, y, w, h);
      g.fillStyle = SIGN_BG;
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.fillStyle = SIGN_TEXT;
      g.fillText(z.label, x + 5, y + h / 2 + 1);
      this.signBoxes.push({ x, y, w, h });
    }
    g.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    g.imageSmoothingEnabled = false;
  }

  /** Night: darken the room through a low-res light map, then add colored glow. */
  private lighting(g: CanvasRenderingContext2D, dyn: Dyn, t: number) {
    const night = 1 - this.day;
    if (night <= 0.01) return;
    const [dc, dg] = this.dark;
    const [tc, tg] = this.tint;
    const lights = this.office.lights(dyn, t);
    dg.globalCompositeOperation = "source-over";
    dg.clearRect(0, 0, dc.width, dc.height);
    dg.fillStyle = `rgba(10, 10, 34, ${0.58 * night})`;
    dg.fillRect(0, 0, dc.width, dc.height);
    dg.globalCompositeOperation = "destination-out";
    tg.clearRect(0, 0, tc.width, tc.height);
    for (const l of lights) {
      const x = l.x / LIGHT_RES;
      const y = l.y / LIGHT_RES;
      const r = l.r / LIGHT_RES;
      const hole = dg.createRadialGradient(x, y, 0, x, y, r);
      hole.addColorStop(0, `rgba(0,0,0,${Math.min(1, l.a * 1.6)})`);
      hole.addColorStop(1, "rgba(0,0,0,0)");
      dg.fillStyle = hole;
      dg.fillRect(x - r, y - r, r * 2, r * 2);
      const glow = tg.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, l.color + "66");
      glow.addColorStop(1, l.color + "00");
      tg.fillStyle = glow;
      tg.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(dc, 0, 0, W * T, H * T);
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 0.45 * night;
    g.drawImage(tc, 0, 0, W * T, H * T);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }

  /** Name tags + bubbles, placed greedily by priority so nothing important overlaps. */
  private overlays(g: CanvasRenderingContext2D, chars: Char[]) {
    interface Item {
      c: Char;
      a: Agent;
      focused: boolean;
      bubble?: MeasuredBubble;
      prio: number;
    }
    const items: Item[] = [];
    for (const c of chars) {
      const a = this.state.agents.get(c.id);
      if (!a || c.alpha < 0.5) continue;
      const focused = c.id === this.selected || c.id === this.hovered;
      const b = bubbleFor(a, this.state, focused);
      const bubble = b ? measureBubble(g, b, focused ? 300 : 220) : undefined;
      const prio = (c.id === this.selected ? 100 : 0) + (c.id === this.hovered ? 50 : 0) + (a.waiting || a.status === "error" ? 30 : 0) + (bubble ? 20 : 0) + (a.status === "busy" ? 10 : 0) + (a.parentId ? 0 : 5);
      items.push({ c, a, focused, bubble, prio });
    }
    items.sort((x, y) => y.prio - x.prio);

    const placed: Box[] = [];
    const draws: (() => void)[] = [];
    const clampX = (x: number, w: number) => Math.max(4, Math.min(this.view.cw - w - 4, x));
    const free = (b: Box) => !placed.some((p) => overlaps(p, b)) && !this.signBoxes.some((p) => overlaps(p, b));

    for (const it of items) {
      const head = this.toScreen(it.c.x, it.c.headY);
      const tagW = measureTag(g, it.a.name);
      const color = it.a.waiting ? STATUS_COLOR.waiting : STATUS_COLOR[it.a.status];
      // try the natural spot, then a few steps upward
      let tag: Box | undefined;
      for (let step = 0; step < 4; step++) {
        const cand = { x: clampX(head.x - tagW / 2, tagW), y: head.y - TAG_H - 3 - step * (TAG_H + 2), w: tagW, h: TAG_H };
        if (free(cand)) {
          tag = cand;
          break;
        }
      }
      if (!tag && it.prio >= 20) tag = { x: clampX(head.x - tagW / 2, tagW), y: head.y - TAG_H - 3, w: tagW, h: TAG_H };
      if (tag) {
        placed.push(tag);
        const t = tag;
        draws.push(() => drawNameTag(g, t.x, t.y, t.w, it.a.name, color, it.focused));
      } else {
        // no room for a label: a small status pip over the head instead
        draws.push(() => {
          g.fillStyle = "#16121f";
          g.fillRect(Math.round(head.x) - 3, Math.round(head.y) - 9, 6, 6);
          g.fillStyle = color;
          g.fillRect(Math.round(head.x) - 2, Math.round(head.y) - 8, 4, 4);
        });
      }
      if (!it.bubble) continue;
      const m = it.bubble;
      const anchorY = (tag ? tag.y : head.y) - 2;
      let box: Box | undefined;
      for (let step = 0; step < 5; step++) {
        const cand = { x: clampX(head.x - m.w / 2, m.w), y: anchorY - m.h - step * 12, w: m.w, h: m.h };
        if (free(cand)) {
          box = cand;
          break;
        }
      }
      if (!box && it.prio < 30) continue; // drop low-priority bubbles rather than stacking them
      box ??= { x: clampX(head.x - m.w / 2, m.w), y: anchorY - m.h, w: m.w, h: m.h };
      placed.push(box);
      const bb = box;
      draws.push(() => drawBubble(g, m, bb.x, bb.y, head.x));
    }
    // highest priority drawn last (on top)
    for (let i = draws.length - 1; i >= 0; i--) draws[i]();
  }

  private empty(g: CanvasRenderingContext2D, msg: string) {
    g.font = `16px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const { cw, ch } = this.view;
    g.fillStyle = "rgba(16,13,24,0.8)";
    const w = g.measureText(msg).width + 30;
    g.fillRect(cw / 2 - w / 2, ch / 2 - 18, w, 36);
    g.fillStyle = "#e9e4ff";
    g.fillText(msg, cw / 2, ch / 2);
    g.textAlign = "start";
  }
}
