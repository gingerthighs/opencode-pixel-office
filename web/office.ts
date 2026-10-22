// Office layout: static background (drawn once), seats/spots, collision grid + BFS, animated props, lights.

import type { AgentStatus, Todo } from "../src/types.ts";
import type { Zone } from "./roles.ts";
import { FONT_H, makeCanvas, pixelText, rect, shade, T, textWidth, type Pose } from "./sprites.ts";

export const W = 32;
export const H = 20;

export interface Tile {
  tx: number;
  ty: number;
}

export interface Seat extends Tile {
  id: string;
  zone: Zone;
  kind: "desk" | "boss" | "table" | "bench" | "studio";
  px: number;
  py: number;
  /** monitor center (world px), absent for seats without a screen */
  mon?: { x: number; y: number; w: number };
}

export interface Spot extends Tile {
  id: string;
  px: number;
  py: number;
  sit: boolean;
  face: Pose;
}

export interface SeatState {
  status: AgentStatus;
  waiting: boolean;
  tool?: string;
}

export interface Dyn {
  seats: Map<string, SeatState>;
  todos: Todo[];
  bash: boolean;
  oracleBusy: boolean;
  lounge: boolean;
  active: number;
  tokens: number;
  daylight: number;
}

export interface Light {
  x: number;
  y: number;
  r: number;
  color: string;
  a: number;
}

interface ZoneDef {
  zone: Zone | "lounge";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  /** sign position: center x, top y (world px) — placed on free floor */
  sign: { x: number; y: number };
}

export const ZONES: ZoneDef[] = [
  { zone: "boss", label: "CHEFBÜRO", x: 1, y: 2, w: 8, h: 6, color: "#6b2f45", sign: { x: 72, y: 113 } },
  { zone: "oracle", label: "ORAKEL", x: 11, y: 2, w: 8, h: 5, color: "#45366e", sign: { x: 240, y: 97 } },
  { zone: "library", label: "BIBLIOTHEK", x: 21, y: 2, w: 10, h: 7, color: "#2c5a4a", sign: { x: 416, y: 99 } },
  { zone: "open", label: "GROSSRAUM", x: 10, y: 8, w: 11, h: 6, sign: { x: 248, y: 226 } },
  { zone: "studio", label: "STUDIO", x: 1, y: 10, w: 8, h: 8, color: "#285866", sign: { x: 80, y: 165 } },
  { zone: "workbench", label: "WERKSTATT", x: 23, y: 10, w: 8, h: 8, color: "#5a4b3c", sign: { x: 432, y: 165 } },
  { zone: "lounge", label: "LOUNGE", x: 13, y: 15, w: 8, h: 4, color: "#3b4561", sign: { x: 272, y: 290 } },
];

const WALL_TOP = "#231f33";
const WALL_FACE = "#4a4462";
const FLOOR = "#8a5b3c";
const OUT = "#16121f";
const WINDOWS = [11, 16];
export const SIGN_RIM = "#8c6a3a";
export const SIGN_BG = "#2a2238";
export const SIGN_TEXT = "#f3e3c3";

/** 0 = night, 1 = day, from the viewer's local clock (dawn 6–8, dusk 18–20). */
export function daylight(d = new Date()): number {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 8 && h < 18) return 1;
  if (h >= 6 && h < 8) return (h - 6) / 2;
  if (h >= 18 && h < 20) return 1 - (h - 18) / 2;
  return 0;
}

function mix(a: string, b: string, k: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

export class Office {
  readonly bg: HTMLCanvasElement;
  readonly seats: Seat[] = [];
  readonly spots: Spot[] = [];
  readonly door: Tile = { tx: 15, ty: 19 };
  private blocked = new Uint8Array(W * H);
  private seatOwner = new Map<string, string>();
  private spotOwner = new Map<string, string>();
  private g: CanvasRenderingContext2D;

  constructor() {
    const [c, g] = makeCanvas(W * T, H * T);
    this.bg = c;
    this.g = g;
    this.build();
  }

  // ---------- allocation ----------

  claimSeat(zone: Zone, agentId: string): Seat | undefined {
    const existing = this.seatOf(agentId);
    if (existing) return existing;
    const free = (s: Seat) => !this.seatOwner.has(s.id);
    const pick =
      this.seats.find((s) => s.zone === zone && free(s)) ??
      this.seats.find((s) => s.zone === "open" && free(s)) ??
      this.seats.find((s) => s.kind !== "boss" && free(s));
    if (pick) this.seatOwner.set(pick.id, agentId);
    return pick;
  }

  seatOf(agentId: string): Seat | undefined {
    for (const [sid, owner] of this.seatOwner) if (owner === agentId) return this.seats.find((s) => s.id === sid);
  }

  releaseSeat(agentId: string) {
    for (const [sid, owner] of this.seatOwner) if (owner === agentId) this.seatOwner.delete(sid);
  }

  claimSpot(agentId: string): Spot | undefined {
    for (const [sid, owner] of this.spotOwner) if (owner === agentId) return this.spots.find((s) => s.id === sid);
    const free = this.spots.filter((s) => !this.spotOwner.has(s.id));
    const pick = free[Math.floor(Math.random() * free.length)];
    if (pick) this.spotOwner.set(pick.id, agentId);
    return pick;
  }

  releaseSpot(agentId: string) {
    for (const [sid, owner] of this.spotOwner) if (owner === agentId) this.spotOwner.delete(sid);
  }

  isSpotTaken(id: string) {
    return this.spotOwner.has(id);
  }

  // ---------- pathing ----------

  isBlocked(tx: number, ty: number) {
    return tx < 0 || ty < 0 || tx >= W || ty >= H || this.blocked[ty * W + tx] === 1;
  }

  randomFreeTile(): Tile {
    for (let i = 0; i < 200; i++) {
      const t = { tx: 1 + Math.floor(Math.random() * (W - 2)), ty: 2 + Math.floor(Math.random() * (H - 3)) };
      if (!this.isBlocked(t.tx, t.ty)) return t;
    }
    return { tx: 15, ty: 17 };
  }

  /** BFS on the tile grid; returns tiles after `from` up to and including `to`. */
  path(from: Tile, to: Tile): Tile[] {
    const start = this.nearestFree(from);
    const idx = (t: Tile) => t.ty * W + t.tx;
    const prev = new Int32Array(W * H).fill(-1);
    const goal = idx(to);
    const q: number[] = [idx(start)];
    prev[idx(start)] = idx(start);
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      if (cur === goal) break;
      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev[n] !== -1) continue;
        if (this.blocked[n] && n !== goal) continue;
        prev[n] = cur;
        q.push(n);
      }
    }
    if (prev[goal] === -1) return [to];
    const out: Tile[] = [];
    for (let cur = goal; cur !== idx(start); cur = prev[cur]) out.push({ tx: cur % W, ty: (cur / W) | 0 });
    return out.reverse();
  }

  private nearestFree(t: Tile): Tile {
    if (!this.isBlocked(t.tx, t.ty)) return t;
    for (let r = 1; r < 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!this.isBlocked(t.tx + dx, t.ty + dy)) return { tx: t.tx + dx, ty: t.ty + dy };
        }
      }
    }
    return t;
  }

  // ---------- static build ----------

  private block(x: number, y: number, w = 1, h = 1) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < W && j < H) this.blocked[j * W + i] = 1;
  }

  private r(x: number, y: number, w: number, h: number, c: string) {
    rect(this.g, x, y, w, h, c);
  }

  /** soft drop shadow, light comes from the top-left */
  private shadow(x: number, y: number, w: number, h: number) {
    this.g.globalAlpha = 0.22;
    this.r(x + 2, y + 2, w, h, "#000");
    this.g.globalAlpha = 1;
  }

  private build() {
    this.floor();
    for (const z of ZONES) if (z.color) this.carpet(z.x, z.y, z.w, z.h, z.color);
    this.walls();

    // boss office
    this.whiteboard(2, 4);
    this.poster(102);
    this.plant(1, 2);
    this.plant(7, 2);
    this.rack(8, 2);
    this.cabinet(1, 6);
    this.addDesk("boss", "boss", 3, 4, 3);

    // oracle
    this.plant(11, 2, 1);
    this.plant(18, 2, 2);
    this.roundTable(13, 3);
    for (const sx of [13, 14, 15]) this.addSeat("oracle", "table", sx, 5, sx * T + 8, 5 * T + 10);

    // library
    for (let x = 21; x < 31; x++) this.bookshelf(x, 2);
    this.addDesk("library", "desk", 22, 4);
    this.addDesk("library", "desk", 27, 4);
    this.addDesk("library", "desk", 22, 7);
    this.addDesk("library", "desk", 27, 7);
    this.globe(25, 4);

    // open plan
    this.addDesk("open", "desk", 11, 9);
    this.addDesk("open", "desk", 14, 9);
    this.addDesk("review", "desk", 17, 9);
    this.lamp(18, 9);
    this.addDesk("open", "desk", 11, 12);
    this.addDesk("open", "desk", 14, 12);
    this.addDesk("open", "desk", 17, 12);
    this.plant(20, 8, 1);
    this.printer(20, 11);
    for (const [x, y] of [[13, 10], [16, 13], [10, 13]] as const) this.bin(x, y);

    // studio
    this.addDesk("studio", "studio", 2, 12);
    this.addDesk("studio", "studio", 5, 12);
    this.addDesk("studio", "studio", 2, 15);
    this.addDesk("studio", "studio", 5, 15);
    this.easel(8, 11);
    this.easel(8, 14, true);

    // workshop
    this.addDesk("workbench", "bench", 24, 12);
    this.addDesk("workbench", "bench", 27, 12);
    this.addDesk("workbench", "bench", 24, 15);
    this.addDesk("workbench", "bench", 27, 15);
    this.toolCabinet(30, 10);
    this.toolCabinet(30, 13);
    this.crates(23, 17);

    // lounge
    this.counter(10, 15, 3);
    this.cooler(13, 15);
    this.sofa(17, 17, 3);
    this.sideTable(256, 272);
    this.plant(10, 18, 2);
    this.plant(21, 18);
    this.plant(1, 18, 1);
    this.plant(30, 18, 2);
    for (const [x, y] of [[11, 16], [12, 16], [14, 16]] as const) {
      this.spots.push({ id: `s${x},${y}`, tx: x, ty: y, px: x * T + 8, py: y * T + 12, sit: false, face: "up" });
    }
    for (const x of [17, 18, 19]) {
      this.spots.push({ id: `sofa${x}`, tx: x, ty: 17, px: x * T + 8, py: 17 * T + 11, sit: true, face: "down" });
    }

    const [sc, sg] = makeCanvas(W * T, H * T);
    this.signLayer = sc;
    for (const z of ZONES) this.sign(sg, z.label, z.sign.x, z.sign.y);
  }

  /** zone signs in world pixels (3×5 font) — used when the view is zoomed in enough to read them */
  signLayer!: HTMLCanvasElement;

  private floor() {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = x * T;
        const py = y * T;
        const tone = (x * 7 + y * 13) % 5 === 0 ? shade(FLOOR, -0.05) : (x * 3 + y * 5) % 7 === 0 ? shade(FLOOR, 0.04) : FLOOR;
        this.r(px, py, T, T, tone);
        this.r(px, py + 7, T, 1, shade(FLOOR, -0.25));
        this.r(px, py + 15, T, 1, shade(FLOOR, -0.25));
        const off = (y % 2) * 8;
        this.r(px + ((off + 3) % 16), py, 1, 7, shade(FLOOR, -0.2));
        this.r(px + ((off + 11) % 16), py + 8, 1, 7, shade(FLOOR, -0.2));
        this.r(px + 5, py + 3, 2, 1, shade(FLOOR, 0.08));
        if ((x + y) % 3 === 0) this.r(px + 12, py + 11, 2, 1, shade(FLOOR, -0.12));
      }
    }
  }

  private carpet(x: number, y: number, w: number, h: number, c: string) {
    const px = x * T + 2;
    const py = y * T + 2;
    const pw = w * T - 4;
    const ph = h * T - 4;
    this.shadow(px - 1, py - 1, pw, ph);
    this.r(px, py, pw, ph, shade(c, -0.25));
    this.r(px + 1, py + 1, pw - 2, ph - 2, c);
    const trim = shade(c, 0.18);
    this.r(px + 3, py + 3, pw - 6, 1, trim);
    this.r(px + 3, py + ph - 4, pw - 6, 1, trim);
    this.r(px + 3, py + 3, 1, ph - 6, trim);
    this.r(px + pw - 4, py + 3, 1, ph - 6, trim);
    // corner ornaments
    for (const [cx, cy] of [[px + 5, py + 5], [px + pw - 7, py + 5], [px + 5, py + ph - 7], [px + pw - 7, py + ph - 7]]) {
      this.r(cx, cy, 2, 2, trim);
    }
    for (let j = py + 8; j < py + ph - 8; j += 6) {
      for (let i = px + 8 + ((j / 6) % 2) * 3; i < px + pw - 8; i += 6) this.r(i, j, 1, 1, shade(c, 0.1));
    }
  }

  private sign(g: CanvasRenderingContext2D, label: string, cx: number, top: number) {
    const w = textWidth(label) + 8;
    const x = Math.round(cx - w / 2);
    const h = FONT_H + 5;
    g.globalAlpha = 0.22;
    rect(g, x + 2, top + 2, w, h, "#000");
    g.globalAlpha = 1;
    rect(g, x, top, w, h, SIGN_RIM);
    rect(g, x + 1, top + 1, w - 2, h - 2, SIGN_BG);
    rect(g, x + 1, top + 1, w - 2, 1, "#3a3150");
    rect(g, x, top, 1, 1, OUT);
    rect(g, x + w - 1, top, 1, 1, OUT);
    pixelText(g, label, x + 4, top + 3, SIGN_TEXT, "#120e1c");
  }

  private walls() {
    this.r(0, 0, W * T, 9, WALL_TOP);
    this.r(0, 9, W * T, 21, WALL_FACE);
    for (let x = 0; x < W * T; x += 32) this.r(x, 9, 1, 21, shade(WALL_FACE, -0.12));
    this.r(0, 9, W * T, 1, shade(WALL_FACE, 0.15));
    this.r(0, 28, W * T, 4, shade(WALL_FACE, -0.35));
    this.r(0, 28, W * T, 1, shade(WALL_FACE, -0.15));
    for (const wx of WINDOWS) this.windowFrame(wx);
    this.tvFrame();
    this.clockFace(20);
    this.block(0, 0, W, 2);
    // sides + bottom
    this.r(0, 0, 10, H * T, WALL_TOP);
    this.r(10, 32, 2, H * T - 48, shade(WALL_TOP, 0.15));
    this.r(W * T - 10, 0, 10, H * T, WALL_TOP);
    this.r(W * T - 12, 32, 2, H * T - 48, shade(WALL_TOP, 0.15));
    this.block(0, 0, 1, H);
    this.block(W - 1, 0, 1, H);
    this.r(0, (H - 1) * T + 6, W * T, 10, WALL_TOP);
    this.r(0, (H - 1) * T + 4, W * T, 2, shade(WALL_TOP, 0.15));
    this.block(0, H - 1, W, 1);
    // door gap with mat
    const d = this.door;
    this.r(d.tx * T, (H - 1) * T, 2 * T, T, FLOOR);
    this.r(d.tx * T - 2, (H - 1) * T + 4, 2, 12, "#5b4a6e");
    this.r(d.tx * T + 2 * T, (H - 1) * T + 4, 2, 12, "#5b4a6e");
    this.r(d.tx * T + 3, (H - 1) * T + 2, 2 * T - 6, 11, "#5b3a29");
    for (let i = 0; i < 4; i++) this.r(d.tx * T + 6 + i * 6, (H - 1) * T + 4, 3, 7, "#7a5236");
    this.blocked[(H - 1) * W + d.tx] = 0;
    this.blocked[(H - 1) * W + d.tx + 1] = 0;
  }

  private windowFrame(tx: number) {
    const x = tx * T;
    this.r(x - 1, 10, 2 * T + 2, 17, "#2a2540");
    this.r(x, 26, 2 * T, 2, "#6c6488");
    this.r(x - 2, 27, 2 * T + 4, 1, "#857da3");
  }

  private tvFrame() {
    this.r(213, 11, 38, 17, "#14121c");
    this.r(229, 28, 6, 2, "#2b2838");
  }

  private clockFace(tx: number) {
    const x = tx * T + 3;
    this.r(x, 11, 11, 11, "#ced4da");
    this.r(x + 1, 12, 9, 9, "#fff");
    this.r(x + 5, 12, 1, 1, "#868e96");
    this.r(x + 5, 20, 1, 1, "#868e96");
    this.r(x + 1, 16, 1, 1, "#868e96");
    this.r(x + 9, 16, 1, 1, "#868e96");
  }

  private poster(x: number) {
    this.r(x, 12, 22, 15, "#1f1a2e");
    this.r(x + 1, 13, 20, 13, "#e8590c");
    this.r(x + 1, 20, 20, 6, "#d9480f");
    pixelText(this.g, "SHIP", x + 3, 14, "#fff4e6");
    pixelText(this.g, "IT", x + 7, 20, "#fff4e6");
  }

  private plant(tx: number, ty: number, variant = 0) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x + 4, y + 9, 8, 6);
    const pot = ["#b35f3b", "#495057", "#e9ecef"][variant];
    this.r(x + 4, y + 9, 8, 6, pot);
    this.r(x + 4, y + 9, 8, 1, shade(pot, 0.2));
    this.r(x + 5, y + 14, 6, 1, shade(pot, -0.25));
    if (variant === 1) {
      // cactus
      this.r(x + 6, y - 1, 4, 10, "#2f9e44");
      this.r(x + 3, y + 2, 3, 2, "#2f9e44");
      this.r(x + 3, y, 2, 3, "#2f9e44");
      this.r(x + 10, y + 3, 3, 2, "#2f9e44");
      this.r(x + 11, y + 1, 2, 3, "#2f9e44");
      this.r(x + 7, y, 1, 8, "#51cf66");
      this.r(x + 7, y - 2, 2, 1, "#ff8787");
    } else if (variant === 2) {
      // tall leafy plant
      this.r(x + 7, y - 4, 2, 13, "#2b8a3e");
      this.r(x + 2, y - 3, 6, 4, "#37b24d");
      this.r(x + 8, y - 6, 6, 4, "#2f9e44");
      this.r(x + 3, y + 2, 5, 4, "#2f9e44");
      this.r(x + 9, y + 1, 5, 4, "#37b24d");
      this.r(x + 4, y - 2, 2, 1, "#69db7c");
      this.r(x + 10, y - 5, 2, 1, "#69db7c");
    } else {
      this.r(x + 3, y + 1, 10, 9, "#2f9e44");
      this.r(x + 5, y - 2, 6, 4, "#37b24d");
      this.r(x + 2, y + 4, 3, 3, "#2b8a3e");
      this.r(x + 11, y + 3, 3, 4, "#2b8a3e");
      this.r(x + 6, y + 2, 2, 2, "#69db7c");
      this.r(x + 9, y + 5, 2, 1, "#69db7c");
    }
    this.block(tx, ty);
  }

  private rack(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T - 10;
    this.shadow(x, y, 14, 40);
    this.r(x, y, 14, 40, "#1e1e2a");
    this.r(x + 1, y + 1, 12, 38, "#2b2b3c");
    for (let i = 0; i < 6; i++) {
      this.r(x + 2, y + 3 + i * 6, 10, 4, "#3a3a52");
      this.r(x + 9, y + 4 + i * 6, 2, 2, "#24243a");
    }
    this.block(tx, ty, 1, 2);
  }

  private cabinet(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T - 6;
    this.shadow(x, y, 14, 21);
    this.r(x, y, 14, 21, "#868e96");
    this.r(x + 1, y + 1, 12, 19, "#adb5bd");
    this.r(x + 1, y + 10, 12, 1, "#868e96");
    this.r(x + 6, y + 5, 3, 1, "#495057");
    this.r(x + 6, y + 14, 3, 1, "#495057");
    // trophy on top
    this.r(x + 5, y - 5, 4, 3, "#fcc419");
    this.r(x + 6, y - 2, 2, 2, "#e67700");
    this.block(tx, ty);
  }

  private whiteboard(tx: number, w: number) {
    const x = tx * T;
    this.r(x, 11, w * T, 16, "#ced4da");
    this.r(x + 1, 12, w * T - 2, 14, "#f8f9fa");
    this.r(x + 2, 26, w * T - 4, 2, "#868e96");
    this.r(x + w * T - 10, 25, 3, 1, "#e03131");
    this.r(x + w * T - 6, 25, 3, 1, "#1c7ed6");
  }

  private bookshelf(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T - 14;
    this.r(x, y, T, 30, "#5c3b24");
    this.r(x + 1, y + 1, T - 2, 28, "#3e2716");
    const colors = ["#c92a2a", "#1971c2", "#2f9e44", "#f08c00", "#862e9c", "#e9ecef", "#0c8599"];
    for (let s = 0; s < 3; s++) {
      const sy = y + 2 + s * 9;
      let bx = x + 2;
      let k = tx * 3 + s * 5;
      while (bx < x + T - 3) {
        const bw = 1 + (k % 2);
        const bh = 6 - (k % 3);
        this.r(bx, sy + (7 - bh), bw, bh, colors[k % colors.length]);
        bx += bw + ((k * 7) % 5 === 0 ? 1 : 0);
        k++;
      }
      this.r(x + 1, sy + 7, T - 2, 1, "#5c3b24");
    }
    this.g.globalAlpha = 0.22;
    this.r(x, y + 30, T, 2, "#000");
    this.g.globalAlpha = 1;
    this.block(tx, ty);
  }

  private globe(tx: number, ty: number) {
    const x = tx * T + 3;
    const y = ty * T - 2;
    this.shadow(x + 1, y + 12, 8, 3);
    this.r(x + 3, y + 11, 4, 4, "#5c3b24");
    this.r(x + 1, y + 1, 8, 9, "#1c7ed6");
    this.r(x, y + 3, 10, 5, "#1c7ed6");
    this.r(x + 2, y + 2, 3, 3, "#40c057");
    this.r(x + 6, y + 5, 3, 3, "#40c057");
    this.r(x + 2, y + 1, 2, 1, "#a5d8ff");
    this.block(tx, ty);
  }

  private roundTable(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x + 1, y + 2, 3 * T - 2, 2 * T - 6);
    this.r(x + 3, y + 1, 3 * T - 6, 2 * T - 6, "#3d2a4f");
    this.r(x + 1, y + 4, 3 * T - 2, 2 * T - 12, "#3d2a4f");
    this.r(x + 4, y + 2, 3 * T - 8, 2 * T - 8, "#5a3f73");
    this.r(x + 2, y + 5, 3 * T - 4, 2 * T - 14, "#5a3f73");
    this.r(x + 6, y + 4, 3 * T - 12, 2, "#7a5a96");
    // tarot cards + candles
    this.r(x + 7, y + 14, 4, 6, "#f1f3f5");
    this.r(x + 8, y + 15, 2, 4, "#7048e8");
    this.r(x + 36, y + 13, 4, 6, "#f1f3f5");
    this.r(x + 37, y + 14, 2, 4, "#e03131");
    this.r(x + 6, y + 6, 2, 4, "#fff3bf");
    this.r(x + 40, y + 6, 2, 4, "#fff3bf");
    this.r(x + 20, y + 16, 8, 3, "#c5a46d");
    this.block(tx, ty, 3, 2);
  }

  private lamp(tx: number, ty: number) {
    const x = tx * T + 11;
    const y = ty * T - 8;
    this.r(x, y + 4, 1, 9, "#495057");
    this.r(x - 3, y, 6, 4, "#40c057");
    this.r(x - 2, y + 4, 4, 1, "#fff3bf");
  }

  private printer(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T - 2;
    this.shadow(x, y, 14, 14);
    this.r(x, y + 4, 14, 10, "#dee2e6");
    this.r(x + 1, y + 5, 12, 2, "#adb5bd");
    this.r(x + 2, y, 10, 5, "#f8f9fa");
    this.r(x + 3, y + 9, 8, 1, "#343a40");
    this.r(x + 11, y + 11, 1, 1, "#40c057");
    this.block(tx, ty);
  }

  private bin(tx: number, ty: number) {
    const x = tx * T + 11;
    const y = ty * T + 6;
    this.shadow(x, y, 4, 5);
    this.r(x, y, 4, 5, "#495057");
    this.r(x, y, 4, 1, "#868e96");
    this.r(x + 1, y - 1, 2, 1, "#f8f9fa");
  }

  private easel(tx: number, ty: number, alt = false) {
    const x = tx * T;
    const y = ty * T - 6;
    this.shadow(x + 3, y + 18, 10, 4);
    this.r(x + 3, y + 14, 1, 8, "#8d6e63");
    this.r(x + 12, y + 14, 1, 8, "#8d6e63");
    this.r(x + 7, y + 14, 2, 8, "#6d4c41");
    this.r(x + 1, y, 14, 15, "#f8f9fa");
    this.r(x + 1, y, 14, 1, "#6d4c41");
    if (alt) {
      this.r(x + 2, y + 8, 12, 6, "#74c0fc");
      this.r(x + 4, y + 3, 4, 4, "#ffd43b");
      this.r(x + 9, y + 9, 3, 2, "#2f9e44");
    } else {
      this.r(x + 3, y + 3, 5, 4, "#4dabf7");
      this.r(x + 7, y + 6, 6, 5, "#ff8787");
      this.r(x + 4, y + 9, 3, 3, "#ffd43b");
    }
    this.block(tx, ty);
  }

  private toolCabinet(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T - 4;
    this.shadow(x, y, 14, 30);
    this.r(x, y, 14, 30, "#c92a2a");
    this.r(x + 1, y + 1, 12, 28, "#e03131");
    for (let i = 0; i < 4; i++) {
      this.r(x + 1, y + 7 + i * 7, 12, 1, "#a61e1e");
      this.r(x + 5, y + 3 + i * 7, 4, 1, "#dee2e6");
    }
    this.block(tx, ty, 1, 2);
  }

  private crates(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T;
    this.shadow(x, y, 14, 14);
    this.r(x, y, 14, 14, "#a9743d");
    this.r(x + 1, y + 1, 12, 12, "#c08a4f");
    this.r(x + 1, y + 6, 12, 1, "#a9743d");
    this.r(x + 6, y + 1, 1, 12, "#a9743d");
    this.block(tx, ty);
  }

  private counter(tx: number, ty: number, w: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x, y - 2, w * T, 18);
    this.r(x, y - 2, w * T, 12, "#dee2e6");
    this.r(x, y + 10, w * T, 6, "#868e96");
    this.r(x, y - 2, w * T, 1, "#f8f9fa");
    for (let i = 1; i < w; i++) this.r(x + i * T, y + 10, 1, 6, "#6c757d");
    // coffee machine
    const cx = x + T + 2;
    this.r(cx, y - 12, 12, 14, "#343a40");
    this.r(cx + 1, y - 11, 10, 4, "#495057");
    this.r(cx + 8, y - 10, 2, 2, "#ff6b6b");
    this.r(cx + 4, y - 4, 4, 1, "#212529");
    this.r(cx + 4, y - 2, 4, 3, "#f8f9fa");
    // mugs + fruit bowl
    this.r(x + 4, y + 1, 3, 3, "#ff922b");
    this.r(x + 2 * T + 3, y + 1, 3, 3, "#4dabf7");
    this.r(x + 2 * T + 9, y, 5, 3, "#e9ecef");
    this.r(x + 2 * T + 10, y - 1, 2, 2, "#fab005");
    this.r(x + 2 * T + 12, y - 1, 2, 2, "#e03131");
    this.block(tx, ty, w, 1);
  }

  private cooler(tx: number, ty: number) {
    const x = tx * T + 3;
    const y = ty * T - 12;
    this.shadow(x, y + 10, 10, 18);
    this.r(x + 1, y, 8, 10, "#74c0fc");
    this.r(x + 2, y + 1, 3, 6, "#a5d8ff");
    this.r(x, y + 10, 10, 18, "#e9ecef");
    this.r(x + 3, y + 13, 4, 2, "#495057");
    this.block(tx, ty);
  }

  private sofa(tx: number, ty: number, w: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x - 4, y - 6, w * T + 8, 20);
    this.r(x - 2, y - 6, w * T + 4, 8, "#364fc7");
    this.r(x - 2, y - 6, w * T + 4, 2, "#4c6ef5");
    this.r(x - 4, y - 4, 4, 18, "#364fc7");
    this.r(x + w * T, y - 4, 4, 18, "#364fc7");
    this.r(x, y + 2, w * T, 12, "#4263eb");
    for (let i = 1; i < w; i++) this.r(x + i * T, y + 2, 1, 12, "#364fc7");
    // cushions
    this.r(x + 2, y - 3, 6, 4, "#ffd43b");
    this.r(x + w * T - 8, y - 3, 6, 4, "#ff8787");
  }

  /** small side table with a reading lamp, left of the sofa (decor only, not blocking) */
  private sideTable(x: number, y: number) {
    this.shadow(x, y, 10, 9);
    this.r(x, y, 10, 9, "#5c3b24");
    this.r(x + 1, y + 1, 8, 5, "#7a5236");
    this.r(x + 4, y - 5, 2, 6, "#495057");
    this.r(x + 2, y - 8, 6, 3, "#ffd43b");
    this.r(x + 6, y + 2, 2, 2, "#f8f9fa");
  }

  /** Desk of width `w` tiles at (dx,dy) with a chair below it, facing up. */
  private addDesk(zone: Zone, kind: Seat["kind"], dx: number, dy: number, w = 2) {
    const x = dx * T;
    const y = dy * T;
    const top = kind === "boss" ? "#6b3a2a" : kind === "bench" ? "#868e96" : kind === "studio" ? "#d8b48a" : "#9c6b45";
    const front = shade(top, -0.35);
    this.shadow(x, y + 1, w * T, 17);
    this.r(x, y + 1, w * T, 11, top);
    this.r(x, y + 1, w * T, 1, shade(top, 0.2));
    this.r(x, y + 12, w * T, 4, front);
    this.r(x + 2, y + 16, 2, 2, shade(front, -0.3));
    this.r(x + w * T - 4, y + 16, 2, 2, shade(front, -0.3));
    const cx = x + (w * T) / 2;
    this.r(cx - 5, y + 9, 10, 2, "#dee2e6");
    this.r(cx - 5, y + 9, 10, 1, "#f8f9fa");
    this.r(cx + 7, y + 9, 2, 2, "#adb5bd"); // mouse
    if (kind === "bench") {
      this.r(x + 2, y + 3, 5, 3, "#495057");
      this.r(x + 3, y + 2, 3, 1, "#868e96");
      this.r(x + w * T - 8, y + 4, 6, 2, "#fab005");
      this.r(x + w * T - 7, y + 3, 1, 1, "#e03131");
    } else if (kind === "studio") {
      this.r(x + 2, y + 4, 6, 5, "#f8f9fa");
      this.r(x + 3, y + 5, 3, 1, "#e64980");
      this.r(x + 3, y + 7, 2, 1, "#4dabf7");
      this.r(x + w * T - 6, y + 3, 1, 6, "#fab005");
      this.r(x + w * T - 4, y + 4, 1, 5, "#e03131");
    } else if (kind === "boss") {
      this.r(x + 3, y + 4, 8, 4, "#f1f3f5");
      this.r(x + 4, y + 5, 6, 1, "#adb5bd");
      this.r(x + w * T - 10, y + 3, 7, 3, "#fcc419"); // nameplate
      this.r(x + w * T - 9, y + 4, 5, 1, "#1d1a2b");
      this.r(x + w * T - 14, y + 7, 3, 3, "#f8f9fa");
    } else {
      this.r(x + 2, y + 5, 3, 3, (dx + dy) % 2 ? "#f8f9fa" : "#ffa94d");
      this.r(x + 3, y + 4, 1, 1, "#e9ecef");
      this.r(x + w * T - 7, y + 3, 5, 6, "#e9ecef");
      this.r(x + w * T - 6, y + 4, 3, 1, "#adb5bd");
      if ((dx * 3 + dy) % 4 === 0) this.r(x + 6, y + 3, 2, 3, "#40c057"); // tiny plant
    }
    this.block(dx, dy, w, 1);
    const sx = Math.floor(cx / T);
    const monW = kind === "boss" ? 20 : 14;
    this.addSeat(zone, kind, sx, dy + 1, cx, (dy + 1) * T + 10, { x: cx, y: y - 1, w: monW });
  }

  private addSeat(zone: Zone, kind: Seat["kind"], tx: number, ty: number, px: number, py: number, mon?: Seat["mon"]) {
    this.r(px - 5, py - 7, 10, 7, "#3b3f5c");
    this.r(px - 5, py - 7, 10, 1, "#4c5175");
    this.chairBack(this.g, px, py);
    this.seats.push({ id: `${tx},${ty}`, zone, kind, tx, ty, px, py, mon });
  }

  chairBack(g: CanvasRenderingContext2D, px: number, py: number) {
    rect(g, px - 6, py - 2, 12, 5, "#2b2e45");
    rect(g, px - 6, py - 2, 12, 1, "#3e4263");
    rect(g, px - 1, py + 3, 2, 1, "#1d1f30");
  }

  // ---------- animated props ----------

  drawDynamic(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    this.windows(g, t, dyn.daylight);
    this.tv(g, t, dyn);
    this.clockHands(g);
    for (const s of this.seats) {
      if (!s.mon) continue;
      this.monitor(g, s, dyn.seats.get(s.id), t);
    }
    // server rack LEDs (busy when anyone runs bash)
    const rx = 8 * T + 4;
    const ry = 2 * T - 6;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const speed = dyn.bash ? 9 : 1.5;
        const on = Math.sin(t * speed + i * 1.7 + j * 2.3) > (dyn.bash ? -0.2 : 0.4);
        rect(g, rx + j * 3, ry + i * 6, 2, 1, on ? (j === 2 ? "#ffa94d" : "#69db7c") : "#2f3a2f");
      }
    }
    this.whiteboardTodos(g, dyn.todos);
    // crystal ball
    const bx = 14 * T + 8;
    const by = 4 * T + 10;
    const glow = dyn.oracleBusy ? 0.5 + 0.5 * Math.sin(t * 5) : 0.15;
    g.globalAlpha = 0.25 + glow * 0.5;
    rect(g, bx - 7, by - 9, 14, 12, "#d0bfff");
    g.globalAlpha = 1;
    rect(g, bx - 4, by - 7, 8, 8, "#9775fa");
    rect(g, bx - 3, by - 8, 6, 10, "#9775fa");
    rect(g, bx - 2, by - 6, 2, 2, "#e5dbff");
    if (dyn.oracleBusy) {
      for (let i = 0; i < 3; i++) {
        const a = t * 2 + (i * Math.PI * 2) / 3;
        rect(g, bx + Math.round(Math.cos(a) * 9), by - 3 + Math.round(Math.sin(a) * 4), 1, 1, "#e5dbff");
      }
    }
    // candle flicker
    for (const cx of [13 * T + 7, 13 * T + 41]) {
      const f = Math.sin(t * 13 + cx) > 0 ? 1 : 0;
      rect(g, cx - f * 0, 3 * T + 4 - f, 1, 2, "#ffa94d");
      rect(g, cx, 3 * T + 5, 1, 1, "#fff3bf");
    }
    // coffee steam
    if (dyn.lounge) {
      const cx = 11 * T + 8;
      for (let i = 0; i < 3; i++) {
        const k = (t * 0.8 + i / 3) % 1;
        g.globalAlpha = 1 - k;
        rect(g, cx + Math.round(Math.sin(k * 6 + i) * 2), 15 * T - 6 - Math.round(k * 10), 1, 2, "#f1f3f5");
      }
      g.globalAlpha = 1;
    }
    // water cooler bubble
    const bk = (t * 0.35) % 1;
    if (bk < 0.5) rect(g, 13 * T + 7, 15 * T - 4 - Math.round(bk * 14), 1, 1, "#e7f5ff");
  }

  private windows(g: CanvasRenderingContext2D, t: number, day: number) {
    const sky = mix("#141c3a", "#74c0fc", day);
    const skyHi = mix("#1f2c55", "#a5d8ff", day);
    for (const tx of WINDOWS) {
      const x = tx * T;
      rect(g, x, 11, 2 * T, 15, sky);
      rect(g, x, 11, 2 * T, 4, skyHi);
      if (day < 0.6) {
        g.globalAlpha = 1 - day / 0.6;
        for (const [sx, sy] of [[4, 14], [21, 17], [9, 21], [26, 13], [14, 19]] as const) {
          const tw = Math.sin(t * 2 + sx * 3) > -0.6 ? "#e9ecef" : "#748ffc";
          rect(g, x + sx, sy, 1, 1, tw);
        }
        if (tx === WINDOWS[1]) {
          rect(g, x + 22, 13, 4, 4, "#fff3bf");
          rect(g, x + 21, 14, 1, 2, "#fff3bf");
          rect(g, x + 24, 13, 2, 2, mix("#141c3a", "#fff3bf", 0.4));
        }
        g.globalAlpha = 1;
      }
      if (day > 0.3) {
        g.globalAlpha = Math.min(1, (day - 0.3) / 0.4);
        const off = ((t * 2 + tx * 9) % 44) - 10;
        rect(g, x + Math.round(off), 15, 8, 2, "#f8f9fa");
        rect(g, x + Math.round(off) + 2, 14, 4, 1, "#f8f9fa");
        if (tx === WINDOWS[0]) rect(g, x + 4, 13, 4, 4, "#ffe066");
        g.globalAlpha = 1;
      }
      // mullions
      rect(g, x + 15, 11, 2, 15, "#2a2540");
      rect(g, x, 18, 2 * T, 1, "#2a2540");
    }
  }

  private tv(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    const x = 215;
    const y = 13;
    rect(g, x - 1, y - 1, 36, 15, "#0b1f14");
    const col = dyn.active > 0 ? "#69db7c" : "#2f9e44";
    pixelText(g, `${dyn.active} AKTIV`, x + 1, y + 1, col);
    const tk = dyn.tokens;
    const tok = tk >= 1e6 ? (tk / 1e6).toFixed(1) + "M" : tk >= 1e3 ? Math.round(tk / 1e3) + "K" : String(tk);
    pixelText(g, `${tok} TOK`, x + 1, y + 7, "#8ce99a");
    // scanline shimmer
    g.globalAlpha = 0.12;
    rect(g, x - 1, y - 1 + (Math.floor(t * 8) % 15), 36, 1, "#ffffff");
    g.globalAlpha = 1;
  }

  private clockHands(g: CanvasRenderingContext2D) {
    const now = new Date();
    const cx = 20 * T + 8;
    const cy = 16;
    const hand = (angle: number, len: number, col: string) => {
      for (let i = 1; i <= len; i++) rect(g, Math.round(cx + Math.sin(angle) * i), Math.round(cy - Math.cos(angle) * i), 1, 1, col);
    };
    hand(((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6), 2, "#1d1a2b");
    hand(now.getMinutes() * (Math.PI / 30), 3, "#495057");
    rect(g, cx, cy, 1, 1, "#e03131");
  }

  private whiteboardTodos(g: CanvasRenderingContext2D, todos: Todo[]) {
    const wx = 2 * T + 3;
    const done = todos.filter((t) => t.status === "completed").length;
    pixelText(g, todos.length ? `TODO ${done}/${todos.length}` : "TODO", wx, 13, "#1c7ed6");
    todos.slice(0, 3).forEach((todo, i) => {
      const y = 20 + i * 2;
      const isDone = todo.status === "completed";
      const active = todo.status === "in_progress";
      rect(g, wx, y, 2, 1, isDone ? "#2f9e44" : active ? "#f08c00" : "#adb5bd");
      const len = 14 + ((todo.content.length * 7) % 30);
      rect(g, wx + 4, y, len, 1, isDone ? "#8ce99a" : active ? "#ffc078" : "#868e96");
    });
    if (todos.length) {
      rect(g, wx + 40, 14, 18, 3, "#dee2e6");
      rect(g, wx + 40, 14, Math.round((18 * done) / todos.length), 3, "#40c057");
    }
  }

  private monitor(g: CanvasRenderingContext2D, s: Seat, st: SeatState | undefined, t: number) {
    const m = s.mon!;
    const x = Math.round(m.x - m.w / 2);
    const y = m.y - 9;
    rect(g, m.x - 2, m.y, 4, 3, "#343a40");
    rect(g, m.x - 4, m.y + 2, 8, 1, "#495057");
    rect(g, x, y, m.w, 10, "#212433");
    const sx = x + 1;
    const sy = y + 1;
    const sw = m.w - 2;
    const sh = 8;
    if (!st) {
      rect(g, sx, sy, sw, sh, "#151821");
      rect(g, sx + 1, sy + 1, 2, 1, "#20263a");
      return;
    }
    let bg = "#1b2b4a";
    if (st.status === "error") bg = Math.sin(t * 6) > 0 ? "#6b1b1b" : "#3b1010";
    else if (st.waiting) bg = Math.sin(t * 5) > 0 ? "#6b4a10" : "#3b2a08";
    else if (st.status === "idle" || st.status === "done") bg = "#162033";
    rect(g, sx, sy, sw, sh, bg);
    if (st.status === "busy" || st.status === "retry") {
      const tool = st.tool ?? "";
      if (/web|fetch|search|context7|exa/.test(tool)) {
        // browser window
        rect(g, sx, sy, sw, 2, "#dee2e6");
        rect(g, sx + 1, sy + 3, sw - 2, 1, "#74c0fc");
        rect(g, sx + 1, sy + 5, sw - 5, 1, "#868e96");
        rect(g, sx + 1, sy + 7, Math.round((sw - 4) * ((t * 0.7) % 1)), 1, "#868e96");
        return;
      }
      const term = /bash|shell|exec|pty/.test(tool);
      const scroll = Math.floor(t * (term ? 8 : 4));
      for (let i = 0; i < 4; i++) {
        const seed = (scroll + i) * 2654435761;
        const len = 2 + (Math.abs(seed) % (sw - 4));
        const indent = (Math.abs(seed >> 3) % 3) * 2;
        const col = term ? "#69db7c" : ["#74c0fc", "#ffd43b", "#b197fc", "#8ce99a"][Math.abs(seed >> 5) % 4];
        rect(g, sx + 1 + indent, sy + 1 + i * 2, Math.min(len, sw - 2 - indent), 1, col);
      }
      if (Math.floor(t * 3) % 2) rect(g, sx + sw - 2, sy + sh - 2, 1, 1, "#f8f9fa");
    } else if (st.status === "idle" || st.status === "done") {
      rect(g, sx + sw / 2 - 1, sy + 3, 2, 2, "#2c3e66");
    }
  }

  // ---------- lights (night mode) ----------

  lights(dyn: Dyn, t: number): Light[] {
    const out: Light[] = [];
    for (const s of this.seats) {
      const st = dyn.seats.get(s.id);
      if (!s.mon || !st) continue;
      const busy = st.status === "busy" || st.status === "retry";
      const color = st.status === "error" ? "#ff6b6b" : st.waiting ? "#ffa94d" : "#74c0fc";
      out.push({ x: s.mon.x, y: s.mon.y + 2, r: busy || st.waiting || st.status === "error" ? 26 : 14, color, a: busy ? 0.55 : 0.3 });
    }
    // ambient ceiling lights per zone
    for (const z of ZONES) out.push({ x: (z.x + z.w / 2) * T, y: (z.y + z.h / 2) * T, r: Math.max(z.w, z.h) * 7, color: "#ffe8b0", a: 0.22 });
    out.push({ x: 18 * T + 11, y: 9 * T - 4, r: 28, color: "#fff3bf", a: 0.5 }); // reviewer lamp
    out.push({ x: 14 * T + 8, y: 4 * T + 6, r: dyn.oracleBusy ? 40 + Math.sin(t * 5) * 4 : 20, color: "#b197fc", a: dyn.oracleBusy ? 0.6 : 0.35 });
    out.push({ x: 13 * T + 7, y: 3 * T + 5, r: 10, color: "#ffa94d", a: 0.4 }); // candles
    out.push({ x: 13 * T + 41, y: 3 * T + 5, r: 10, color: "#ffa94d", a: 0.4 });
    out.push({ x: 11 * T + 8, y: 15 * T - 6, r: 16, color: "#ff8787", a: 0.3 }); // coffee machine
    out.push({ x: 261, y: 266, r: 24, color: "#ffd43b", a: 0.45 }); // sofa reading lamp
    out.push({ x: 232, y: 20, r: 22, color: "#69db7c", a: 0.35 }); // wall TV
    out.push({ x: 8 * T + 8, y: 2 * T + 6, r: 16, color: "#69db7c", a: dyn.bash ? 0.45 : 0.2 }); // rack
    for (const tx of WINDOWS) out.push({ x: tx * T + 16, y: 34, r: 30, color: "#a5b4fc", a: 0.25 }); // moonlight
    out.push({ x: this.door.tx * T + 16, y: H * T - 8, r: 20, color: "#ffe8b0", a: 0.25 });
    return out;
  }
}
