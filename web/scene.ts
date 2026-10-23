// Canvas renderer: office with permanent staff + temps, cat, night lighting, threads, building view, overlays.

import type { Agent, Room } from "../src/types.ts";
import { bubbleFor, drawBubble, drawNameTag, FONT, measureBubble, measureTag, overlaps, TAG_H, type BubbleContent, type Box, type MeasuredBubble } from "./bubbles.ts";
import { Cat, Person, type Activity, type World } from "./characters.ts";
import { daylight, H, Office, SIGN_BG, SIGN_RIM, SIGN_TEXT, W, ZONES, type DeskPapers, type Dyn, type SeatState } from "./office.ts";
import { lookOf, roleOf, STAFF, STATUS_COLOR, TEMP_NAMES, teamOf } from "./roles.ts";
import { icon, makeCanvas, T, type IconName } from "./sprites.ts";
import type { ClientState } from "./state.ts";

const LIGHT_RES = 4; // world px per light-map cell → chunky, pixel-style light pools
const ELEVATOR_MS = 420;

const ACTIVITY_ICON: Record<Activity, IconName> = {
  coffee: "coffee",
  sofa: "tv",
  beanbag: "tv",
  arcade: "game",
  pingpong: "pingpong",
  phone: "phone",
  pc: "globe",
  cat: "heart",
  wander: "speech",
};

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export interface PersonInfo {
  key: string;
  name: string;
  team: string;
  temp: boolean;
  status: string;
  done: number;
  agentId?: string;
  look: Person["look"];
}

export class Scene {
  roomId?: string;
  /** selection key: an agent id, or "p:<personId>" for someone off duty */
  selected?: string;
  showThreads = false;
  mode: "office" | "building" = "office";
  onSelect?: (key: string | undefined) => void;
  onPickRoom?: (roomId: string) => void;
  onModeChange?: (mode: "office" | "building") => void;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private state: ClientState;
  private office = new Office();
  private cat = new Cat(this.office);
  private people = new Map<string, Person>();
  private byAgent = new Map<string, Person>();
  /** who worked on which session — kept after delivery and across room switches */
  private credits = new Map<string, { name: string; team: string; temp: boolean; look: Person["look"] }>();
  private deskTask = new Set<string>();
  private inbox = 0;
  private outbox = 0;
  private tempSeq = 0;
  private teleport = true;
  private last = performance.now();
  private hovered?: string;
  private view = { s: 1, ox: 0, oy: 0, cw: 0, ch: 0 };
  private dark = makeCanvas((W * T) / LIGHT_RES, (H * T) / LIGHT_RES);
  private tint = makeCanvas((W * T) / LIGHT_RES, (H * T) / LIGHT_RES);
  private day = 1;
  private dayCheckedAt = -Infinity;
  private signBoxes: Box[] = [];
  private badge?: Box;
  private roomBoxes: { box: Box; id: string }[] = [];
  private elevator?: { t0: number; to?: string; switched: boolean };

  constructor(canvas: HTMLCanvasElement, state: ClientState) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.state = state;
    canvas.addEventListener("click", (e) => this.click(e));
    canvas.addEventListener("mousemove", (e) => {
      this.hovered = this.mode === "office" ? this.hitPerson(e) : undefined;
      const overUi = this.mode === "building" ? !!this.hitRoom(e) : !!this.hovered || this.onBadge(e);
      canvas.style.cursor = overUi ? "pointer" : "default";
    });
    canvas.addEventListener("mouseleave", () => (this.hovered = undefined));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- public API ----------

  setRoom(id: string | undefined) {
    if (id === this.roomId) return;
    if (this.roomId && id && !this.elevator) {
      this.elevator = { t0: performance.now(), to: id, switched: false };
      return;
    }
    this.roomId = id;
    this.reset();
  }

  setMode(mode: "office" | "building") {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onModeChange?.(mode);
  }

  /** Rebuild the office for the current room: staff placed instantly, no walk-ins. */
  reset() {
    this.office = new Office();
    this.cat = new Cat(this.office);
    this.people.clear();
    this.byAgent.clear();
    this.deskTask.clear();
    this.outbox = 0;
    this.inbox = this.roomId ? this.state.roomAgents(this.roomId).filter((a) => a.status === "done").length : 0;
    for (const def of STAFF) {
      const id = "staff:" + def.key;
      const zone = roleOf(def.team).zone;
      const p = new Person({
        id,
        name: def.name,
        team: def.team,
        look: lookOf(def.team, def.key),
        staff: def,
        home: this.office.claimSeat(zone, id),
        isBoss: def.team === "orchestrator",
      });
      this.people.set(id, p);
    }
    this.teleport = true;
  }

  /** assign new sessions to people now, independent of animation frames (background tabs pause rAF) */
  syncNow() {
    this.sync(performance.now());
  }

  /** display name for an agent's worker (e.g. "Ella") */
  workerName(agentId: string): string | undefined {
    return this.byAgent.get(agentId)?.name ?? this.credits.get(agentId)?.name;
  }

  personInfo(key: string): PersonInfo | undefined {
    const p = key.startsWith("p:") ? this.people.get(key.slice(2)) : this.byAgent.get(key);
    if (!p) {
      const c = this.credits.get(key);
      return c && { key, ...c, status: "Auftrag abgegeben", done: 0, agentId: key };
    }
    return { key, name: p.name, team: p.team, temp: p.temp, status: p.statusText, done: p.done, agentId: p.agentId, look: p.look };
  }

  /** everyone currently in the office, for the team list */
  roster(): PersonInfo[] {
    return [...this.people.values()]
      .filter((p) => !p.gone)
      .map((p) => this.personInfo(p.agentId ?? "p:" + p.id)!)
      .filter(Boolean);
  }

  // ---------- geometry ----------

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

  private local(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private keyOf(p: Person) {
    return p.agentId ?? "p:" + p.id;
  }

  private hitPerson(e: MouseEvent): string | undefined {
    const l = this.local(e);
    const p = this.toWorld(l.x, l.y);
    const hits = [...this.people.values()].filter((c) => !c.gone && c.hit(p.x, p.y)).sort((a, b) => b.y - a.y);
    if (hits[0]) return this.keyOf(hits[0]);
    // clicking a desk selects whoever works there (paper stack)
    for (const person of this.people.values()) {
      const s = person.home;
      if (!s?.mon || !person.agentId) continue;
      if (Math.abs(p.x - s.px) < 16 && p.y > s.mon.y - 10 && p.y < s.mon.y + 16) return person.agentId;
    }
  }

  private hitRoom(e: MouseEvent) {
    const l = this.local(e);
    return this.roomBoxes.find((r) => l.x >= r.box.x && l.x <= r.box.x + r.box.w && l.y >= r.box.y && l.y <= r.box.y + r.box.h)?.id;
  }

  private onBadge(e: MouseEvent) {
    const l = this.local(e);
    const b = this.badge;
    return !!b && l.x >= b.x && l.x <= b.x + b.w && l.y >= b.y && l.y <= b.y + b.h;
  }

  private click(e: MouseEvent) {
    if (this.mode === "building") {
      const id = this.hitRoom(e);
      if (id) {
        this.onPickRoom?.(id);
        this.setMode("office");
      }
      return;
    }
    if (this.onBadge(e)) return this.setMode("building");
    this.onSelect?.(this.hitPerson(e));
  }

  // ---------- simulation ----------

  private world(now: number): World {
    return {
      office: this.office,
      now,
      cat: this.cat,
      onPickup: () => (this.outbox = Math.max(0, this.outbox - 1)),
      onTaskOnDesk: (p) => p.home && this.deskTask.add(p.home.id),
      onLeaveDesk: (p) => p.home && this.deskTask.delete(p.home.id),
      onDeliver: () => this.inbox++,
    };
  }

  private assign(a: Agent): Person {
    if (!a.parentId) return this.people.get("staff:otto")!;
    const team = teamOf(a.name);
    const free = [...this.people.values()].find((p) => p.staff && !p.isBoss && p.team === team && !p.agentId && !p.gone);
    if (free) return free;
    const id = "temp:" + a.id;
    const temp = new Person({
      id,
      // same session → same temp, even after the view is rebuilt
      name: this.credits.get(a.id)?.name ?? TEMP_NAMES[this.tempSeq++ % TEMP_NAMES.length],
      team: team ?? a.name,
      look: lookOf(a.name, a.id),
      home: this.office.claimSeat("temp", id),
      temp: true,
    });
    temp.enterAt(this.office);
    this.people.set(id, temp);
    return temp;
  }

  private sync(now: number) {
    const w = this.world(now);
    const agents = this.roomId ? this.state.roomAgents(this.roomId) : [];
    for (const a of agents.sort((x, y) => (x.parentId ? 1 : 0) - (y.parentId ? 1 : 0))) {
      if (this.byAgent.has(a.id) || a.status === "done") continue;
      const p = this.assign(a);
      p.bind(a.id, this.office);
      this.byAgent.set(a.id, p);
      this.credits.set(a.id, { name: p.name, team: p.team, temp: p.temp, look: p.look });
      if (this.teleport) p.settle(w);
      else if (!p.isBoss) this.outbox++;
    }
    if (this.teleport) for (const p of this.people.values()) if (!p.agentId) p.settle(w);
    this.teleport = false;
    for (const [aid, p] of this.byAgent) if (p.agentId !== aid) this.byAgent.delete(aid);
    for (const [id, p] of this.people) if (p.gone) this.people.delete(id);
  }

  private dyn(t: number): Dyn {
    const seats = new Map<string, SeatState>();
    const desks = new Map<string, DeskPapers>();
    let bash = false;
    let oracleBusy = false;
    let lounge = false;
    let active = 0;
    let tokens = 0;
    let tvWatchers = 0;
    let arcade = false;
    let pingers = 0;
    let todos: Agent["todos"] = [];
    for (const p of this.people.values()) {
      const a = p.agentId ? this.state.agents.get(p.agentId) : undefined;
      if (a) {
        if (!a.parentId) todos = a.todos;
        tokens += a.tokens;
        const busy = a.status === "busy" || a.status === "retry";
        if (busy) active++;
        if (busy && a.tool?.state === "running" && /bash|shell|exec|pty/.test(a.tool.name)) bash = true;
        if (p.home && (p.phase === "work" || p.isBoss)) {
          desks.set(p.home.id, { task: this.deskTask.has(p.home.id), stack: a.edits });
        }
        if (p.atDesk && p.home) {
          seats.set(p.home.id, { status: a.status, waiting: a.waiting, tool: a.tool?.state === "running" ? a.tool.name : undefined });
          if (p.home.zone === "oracle" && busy) oracleBusy = true;
        }
      } else if (p.browsing && p.home) {
        seats.set(p.home.id, { status: "idle", waiting: false, browsing: true });
      }
      if (!p.agentId && !p.walking) {
        if ((p.activity === "sofa" || p.activity === "beanbag") && p.sitting) tvWatchers++;
        if (p.activity === "arcade") arcade = true;
        if (p.activity === "pingpong") pingers++;
        if (p.activity === "coffee") lounge = true;
      }
    }
    return {
      seats,
      desks,
      todos,
      bash,
      oracleBusy,
      lounge,
      active,
      tokens,
      daylight: this.day,
      inbox: this.inbox,
      outbox: this.outbox,
      tvWatchers,
      arcade,
      pingpong: pingers >= 2,
      ballT: t * 0.9,
    };
  }

  private frame(ts: number) {
    // background tabs pause rAF; after a long gap, rebuild instead of replaying every walk
    if (ts - this.last > 1500) this.reset();
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    const now = performance.now();
    if (now - this.dayCheckedAt > 30_000) {
      const forced = new URLSearchParams(location.search).get("time");
      this.day = forced === "night" ? 0 : forced === "day" ? 1 : daylight();
      this.dayCheckedAt = now;
    }
    // elevator: switch rooms while the doors are shut
    if (this.elevator && !this.elevator.switched && now - this.elevator.t0 > ELEVATOR_MS) {
      this.elevator.switched = true;
      this.roomId = this.elevator.to;
      this.reset();
    }
    if (this.elevator && now - this.elevator.t0 > ELEVATOR_MS * 2) this.elevator = undefined;

    this.sync(now);
    const w = this.world(now);
    for (const p of this.people.values()) p.update(dt, p.agentId ? this.state.agents.get(p.agentId) : undefined, w);
    this.cat.update(dt, this.office, now, [...this.people.values()].filter((p) => !p.walking));
    this.draw(ts / 1000);
    requestAnimationFrame((n) => this.frame(n));
  }

  // ---------- drawing ----------

  private draw(t: number) {
    const g = this.g;
    const dpr = devicePixelRatio || 1;
    const { cw, ch } = this.view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#100d18";
    g.fillRect(0, 0, cw, ch);
    if (this.mode === "building") this.drawBuilding(g, t);
    else this.drawOffice(g, t, dpr);
    this.drawElevator(g);
  }

  private drawOffice(g: CanvasRenderingContext2D, t: number, dpr: number) {
    const { s, ox, oy } = this.view;
    g.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.office.bg, 0, 0);
    const dyn = this.dyn(t);
    this.office.drawDynamic(g, t, dyn);
    this.signs(g, dpr);

    const people = [...this.people.values()];
    const actors: { y: number; draw: () => void }[] = people.map((p) => ({
      y: p.y,
      draw: () => p.draw(g, t, p.agentId ? this.state.agents.get(p.agentId) : undefined, this.office, this.keyOf(p) === this.selected),
    }));
    actors.push({ y: this.cat.y, draw: () => this.cat.draw(g, t) });
    for (const row of this.office.propRows()) actors.push({ y: row.sortY, draw: () => row.draw(g, t, dyn) });
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());

    if (this.showThreads) this.threads(g, t);
    this.lighting(g, dyn, t);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.roomId) this.empty(g, "Noch keine Session – starte etwas in opencode.");
    this.overlays(g, people);
    this.floorBadge(g);
  }

  /** dotted, moving threads from each worker back to whoever assigned the work */
  private threads(g: CanvasRenderingContext2D, t: number) {
    const boss = this.people.get("staff:otto");
    for (const p of this.people.values()) {
      if (!p.agentId || p.isBoss || p.gone) continue;
      const a = this.state.agents.get(p.agentId);
      const parent = (a?.parentId && this.byAgent.get(a.parentId)) || boss;
      if (!parent || parent === p) continue;
      const x0 = parent.x;
      const y0 = parent.headY - 4;
      const x1 = p.x;
      const y1 = p.headY - 4;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.floor(len / 3);
      const off = Math.floor(t * 8) % 3;
      g.fillStyle = p.look.shirt;
      for (let i = off; i < steps; i += 3) {
        const k = i / steps;
        const sag = Math.sin(Math.PI * k) * Math.min(18, len / 6);
        g.fillRect(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k + sag), 2, 1);
      }
    }
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
  private overlays(g: CanvasRenderingContext2D, people: Person[]) {
    interface Item {
      p: Person;
      a?: Agent;
      focused: boolean;
      bubble?: MeasuredBubble;
      prio: number;
    }
    const items: Item[] = [];
    for (const p of people) {
      if (p.gone || p.alpha < 0.5) continue;
      const key = this.keyOf(p);
      const a = p.agentId ? this.state.agents.get(p.agentId) : undefined;
      const focused = key === this.selected || key === this.hovered;
      let b: BubbleContent | undefined;
      if (a) b = bubbleFor(a, this.state, focused);
      if (!b && (p.carrying || p.phase === "fetch")) b = { icon: "paper", text: p.carrying === "report" ? "Bericht für den Chef" : "neuer Auftrag", tone: "normal" };
      if (!b && focused && !a) b = { icon: p.activity ? ACTIVITY_ICON[p.activity] : "zzz", text: p.statusText, tone: "normal" };
      const bubble = b ? measureBubble(g, b, focused ? 300 : 220) : undefined;
      const working = !!a && (a.status === "busy" || a.status === "retry" || a.waiting || a.status === "error");
      const prio =
        (key === this.selected ? 100 : 0) +
        (key === this.hovered ? 50 : 0) +
        (a?.waiting || a?.status === "error" ? 30 : 0) +
        (bubble && (working || p.carrying) ? 20 : 0) +
        (working ? 10 : 0) +
        (p.isBoss ? 5 : 0);
      items.push({ p, a, focused, bubble, prio });
    }
    items.sort((x, y) => y.prio - x.prio);

    const placed: Box[] = [];
    const draws: (() => void)[] = [];
    const clampX = (x: number, w: number) => Math.max(4, Math.min(this.view.cw - w - 4, x));
    const free = (b: Box) => !placed.some((p) => overlaps(p, b)) && !this.signBoxes.some((p) => overlaps(p, b));

    for (const it of items) {
      const head = this.toScreen(it.p.x, it.p.headY);
      const label = it.p.name;
      const tagW = measureTag(g, label);
      const color = it.a ? (it.a.waiting ? STATUS_COLOR.waiting : STATUS_COLOR[it.a.status]) : "#5c5470";
      // at a desk the person looks up at the monitor: name under the chair, bubble above the screen
      const mon = it.p.atDesk ? it.p.home?.mon : undefined;
      const tagSlot = (step: number): Box =>
        mon
          ? { x: clampX(head.x - tagW / 2, tagW), y: this.toScreen(it.p.x, it.p.y + 5).y + step * (TAG_H + 2), w: tagW, h: TAG_H }
          : { x: clampX(head.x - tagW / 2, tagW), y: head.y - TAG_H - 3 - step * (TAG_H + 2), w: tagW, h: TAG_H };
      let tag: Box | undefined;
      for (let step = 0; step < 4; step++) {
        const cand = tagSlot(step);
        if (free(cand)) {
          tag = cand;
          break;
        }
      }
      if (!tag && it.prio >= 20) tag = tagSlot(0);
      if (tag) {
        placed.push(tag);
        const tb = tag;
        draws.push(() => drawNameTag(g, tb.x, tb.y, tb.w, label, color, it.focused));
      } else if (it.a) {
        draws.push(() => {
          g.fillStyle = "#16121f";
          g.fillRect(Math.round(head.x) - 3, Math.round(head.y) - 9, 6, 6);
          g.fillStyle = color;
          g.fillRect(Math.round(head.x) - 2, Math.round(head.y) - 8, 4, 4);
        });
      }
      if (!it.bubble) continue;
      const m = it.bubble;
      const anchorY = mon ? this.toScreen(mon.x, mon.y - 11).y : (tag ? tag.y : head.y) - 2;
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
    for (let i = draws.length - 1; i >= 0; i--) draws[i]();
  }

  /** "floor N · project" plate in the corner; click opens the building view */
  private floorBadge(g: CanvasRenderingContext2D) {
    const room = this.roomId ? this.state.rooms.get(this.roomId) : undefined;
    if (!room) {
      this.badge = undefined;
      return;
    }
    const floors = this.floors();
    const idx = floors.findIndex((f) => f.dir === room.directory);
    const text = `Etage ${idx + 1} · ${basename(room.directory) || "—"}`;
    g.font = `12px ${FONT}`;
    const w = Math.ceil(g.measureText(text).width) + 34;
    const x = 8;
    const y = 8;
    g.fillStyle = "rgba(16,13,24,0.85)";
    g.fillRect(x, y, w, 22);
    g.fillStyle = SIGN_RIM;
    g.fillRect(x, y + 21, w, 1);
    // elevator glyph
    g.fillStyle = "#adb5bd";
    g.fillRect(x + 6, y + 4, 14, 14);
    g.fillStyle = "#495057";
    g.fillRect(x + 7, y + 5, 6, 12);
    g.fillRect(x + 14, y + 5, 5, 12);
    g.fillStyle = "#ffd43b";
    g.fillRect(x + 12, y + 2, 2, 2);
    g.fillStyle = "#f1ecff";
    g.textBaseline = "middle";
    g.fillText(text, x + 26, y + 12);
    this.badge = { x, y, w, h: 22 };
  }

  // ---------- building view ----------

  private floors(): { dir: string; rooms: Room[] }[] {
    const by = new Map<string, Room[]>();
    for (const r of this.state.sortedRooms()) {
      const list = by.get(r.directory) ?? [];
      list.push(r);
      by.set(r.directory, list);
    }
    return [...by.entries()].map(([dir, rooms]) => ({ dir, rooms })).sort((a, b) => a.dir.localeCompare(b.dir));
  }

  private drawBuilding(g: CanvasRenderingContext2D, t: number) {
    const { cw, ch } = this.view;
    const floors = this.floors();
    this.roomBoxes = [];
    // sky
    const night = 1 - this.day;
    g.fillStyle = night > 0.5 ? "#141c3a" : "#74c0fc";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = night > 0.5 ? "#1f2c55" : "#a5d8ff";
    g.fillRect(0, 0, cw, ch * 0.3);
    if (night > 0.5) {
      for (let i = 0; i < 40; i++) {
        g.fillStyle = Math.sin(t * 2 + i) > -0.5 ? "#e9ecef" : "#748ffc";
        g.fillRect((i * 97) % cw, (i * 53) % Math.max(1, ch * 0.5), 2, 2);
      }
    }
    // ground
    g.fillStyle = "#2b8a3e";
    g.fillRect(0, ch - 24, cw, 24);
    g.fillStyle = "#37b24d";
    g.fillRect(0, ch - 24, cw, 4);

    const fh = Math.max(46, Math.min(72, (ch - 90) / Math.max(1, floors.length)));
    const bw = Math.min(cw - 32, 760);
    const bx = Math.round((cw - bw) / 2);
    const bh = fh * floors.length + 18;
    const by = Math.max(40, ch - 24 - bh);
    // roof + sign
    g.fillStyle = "#3b2a4f";
    g.fillRect(bx - 8, by - 14, bw + 16, 14);
    g.fillStyle = "#5c3b7a";
    g.fillRect(bx - 8, by - 14, bw + 16, 3);
    g.font = `600 13px ${FONT}`;
    g.textBaseline = "middle";
    g.fillStyle = "#ffd43b";
    g.fillText("PIXEL OFFICE TOWER", bx + 8, by - 26);
    g.fillStyle = "#4a4462";
    g.fillRect(bx, by, bw, bh);
    const shaftW = 34;
    g.fillStyle = "#2a2540";
    g.fillRect(bx + bw - shaftW - 6, by + 4, shaftW, bh - 8);

    if (!floors.length) {
      g.fillStyle = "#f1ecff";
      g.font = `14px ${FONT}`;
      g.fillText("Noch keine Etagen – starte eine Session.", bx + 20, by + bh / 2);
    }
    const current = this.roomId ? this.state.rooms.get(this.roomId) : undefined;
    floors.forEach((f, i) => {
      // top floor = last in list
      const fy = by + bh - 10 - (i + 1) * fh;
      g.fillStyle = "#231f33";
      g.fillRect(bx, fy + fh - 4, bw, 4);
      g.fillStyle = "#f1ecff";
      g.font = `600 12px ${FONT}`;
      g.fillText(`${i + 1}`, bx + 8, fy + fh / 2);
      g.font = `11px ${FONT}`;
      g.fillStyle = "#c9c2e6";
      const label = basename(f.dir) || "—";
      g.fillText(label.length > 14 ? label.slice(0, 13) + "…" : label, bx + 24, fy + fh / 2);
      const roomsX = bx + 120;
      const roomW = Math.max(70, Math.min(150, (bw - 120 - shaftW - 24) / Math.max(1, f.rooms.length) - 8));
      f.rooms.slice(0, Math.floor((bw - 120 - shaftW - 24) / (roomW + 8))).forEach((r, k) => {
        const rx = roomsX + k * (roomW + 8);
        const ry = fy + 6;
        const rh = fh - 14;
        const busy = this.state.roomBusy(r.id);
        const isCurrent = current?.id === r.id;
        g.fillStyle = isCurrent ? "#ffd43b" : "#231f33";
        g.fillRect(rx - 2, ry - 2, roomW + 4, rh + 4);
        g.fillStyle = busy ? (night > 0.5 ? "#ffe066" : "#fff3bf") : "#1c2a52";
        g.fillRect(rx, ry, roomW, rh);
        // little people silhouettes for active agents
        const n = this.state.roomAgents(r.id).filter((a) => a.status !== "done").length;
        for (let j = 0; j < Math.min(n, Math.floor(roomW / 9)); j++) {
          const px = rx + 5 + j * 9;
          const bob = busy ? Math.floor(t * 4 + j) % 2 : 0;
          g.fillStyle = "#3b2a4f";
          g.fillRect(px, ry + rh - 13 - bob, 5, 5);
          g.fillRect(px - 1, ry + rh - 8 - bob, 7, 7);
        }
        g.fillStyle = busy ? "#3b2a4f" : "#adb5bd";
        g.font = `10px ${FONT}`;
        const title = r.title !== "Session" ? r.title : new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        g.fillText(title.length > roomW / 6 ? title.slice(0, Math.floor(roomW / 6) - 1) + "…" : title, rx + 4, ry + 8);
        this.roomBoxes.push({ box: { x: rx, y: ry, w: roomW, h: rh }, id: r.id });
      });
      // elevator cabin at the current floor
      if (current && f.dir === current.directory) {
        g.fillStyle = "#adb5bd";
        g.fillRect(bx + bw - shaftW - 2, fy + 6, shaftW - 8, fh - 14);
        g.fillStyle = "#868e96";
        g.fillRect(bx + bw - shaftW / 2 - 6, fy + 6, 1, fh - 14);
      }
    });
    g.fillStyle = "#f1ecff";
    g.font = `12px ${FONT}`;
    g.fillText("Büro anklicken zum Hinfahren", bx, by + bh + 12 > ch - 30 ? 20 : by + bh + 12);
  }

  private drawElevator(g: CanvasRenderingContext2D) {
    const e = this.elevator;
    if (!e) return;
    const { cw, ch } = this.view;
    const k = (performance.now() - e.t0) / ELEVATOR_MS;
    const closed = k < 1 ? k : Math.max(0, 2 - k); // 0 open … 1 shut
    const half = (cw / 2) * Math.min(1, closed);
    g.fillStyle = "#868e96";
    g.fillRect(0, 0, half, ch);
    g.fillRect(cw - half, 0, half, ch);
    g.fillStyle = "#adb5bd";
    g.fillRect(half - 6, 0, 4, ch);
    g.fillRect(cw - half + 2, 0, 4, ch);
    if (closed > 0.9) {
      g.fillStyle = "#16121f";
      g.fillRect(cw / 2 - 40, ch / 2 - 14, 80, 28);
      g.fillStyle = "#ff922b";
      g.font = `600 14px ${FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const room = e.to ? this.state.rooms.get(e.to) : undefined;
      g.fillText(room ? basename(room.directory).slice(0, 10) : "…", cw / 2, ch / 2);
      g.textAlign = "start";
    }
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

  /** icon image for the panel's staff list */
  static activityIcon(a?: Activity): HTMLCanvasElement {
    return icon(a ? ACTIVITY_ICON[a] : "zzz");
  }
}
