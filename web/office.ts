// Office layout: static background (drawn once), seats/spots, collision grid + BFS, animated props, lights.

import type { AgentStatus, Todo } from "../src/types.ts";
import type { Zone } from "./roles.ts";
import { FONT_H, makeCanvas, pixelText, rect, shade, T, textWidth, type Pose } from "./sprites.ts";

export const W = 32;
export const H = 24;

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

export type SpotKind = "coffee" | "sofa" | "beanbag" | "arcade" | "pingpong" | "cat-tree" | "cat-bed" | "cat-food";

export interface Spot extends Tile {
  id: string;
  kind: SpotKind;
  px: number;
  py: number;
  sit: boolean;
  face: Pose;
  /** free tile to step from/to when the spot itself is blocked (sofa) */
  via?: Tile;
}

export interface SeatState {
  status: AgentStatus;
  waiting: boolean;
  tool?: string;
  /** off-duty staff surfing the web at their desk */
  browsing?: boolean;
}

export interface DeskPapers {
  /** an assignment sheet lies on the desk */
  task: boolean;
  /** finished pages (one per edit), capped when drawn */
  stack: number;
}

export interface Dyn {
  seats: Map<string, SeatState>;
  desks: Map<string, DeskPapers>;
  /** finished reports in the boss inbox / open assignments in the outbox */
  inbox: number;
  outbox: number;
  tvWatchers: number;
  arcade: boolean;
  pingpong: boolean;
  ballT: number;
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
  zone: Zone | "lounge" | "cat" | "games";
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
  { zone: "lounge", label: "LOUNGE", x: 10, y: 15, w: 12, h: 8, color: "#3b4561", sign: { x: 256, y: 355 } },
  { zone: "cat", label: "KATZENECKE", x: 1, y: 19, w: 6, h: 4, color: "#5a3550", sign: { x: 64, y: 291 } },
  { zone: "games", label: "SPIELECKE", x: 23, y: 19, w: 8, h: 4, color: "#2e4d3c", sign: { x: 432, y: 291 } },
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
  readonly door: Tile = { tx: 15, ty: H - 1 };
  /** where workers fetch assignments (outbox, right of the boss desk) and drop reports (inbox, left) */
  readonly pickup: (Tile & { face: Pose })[] = [{ tx: 6, ty: 4, face: "left" }, { tx: 6, ty: 5, face: "up" }, { tx: 7, ty: 4, face: "left" }];
  readonly dropoff: (Tile & { face: Pose })[] = [{ tx: 2, ty: 4, face: "right" }, { tx: 2, ty: 5, face: "up" }, { tx: 2, ty: 3, face: "down" }];
  readonly lounge = { x: 10, y: 15, w: 12, h: 8 };
  private blocked = new Uint8Array(W * H);
  private seatOwner = new Map<string, string>();
  private spotOwner = new Map<string, string>();
  /** current draw target: the floor/wall background or one furniture row layer */
  private g: CanvasRenderingContext2D;
  private base: CanvasRenderingContext2D;
  /**
   * Upright furniture is drawn into one layer per tile row (the row the object stands on) so the
   * scene can depth-sort it with people and the cat: whoever walks behind a desk disappears behind
   * its monitor instead of being painted over it.
   */
  private rows = new Map<number, { c: HTMLCanvasElement; y0: number }>();

  constructor() {
    const [c, g] = makeCanvas(W * T, H * T);
    this.bg = c;
    this.g = g;
    this.base = g;
    this.build();
  }

  /** draw `fn` into the furniture layer of tile row `row` */
  private onRow(row: number, fn: () => void) {
    let layer = this.rows.get(row);
    if (!layer) {
      const y0 = row * T - 40;
      const [c, g] = makeCanvas(W * T, 64);
      g.translate(0, -y0);
      layer = { c, y0 };
      this.rows.set(row, layer);
    }
    const prev = this.g;
    this.g = layer.c.getContext("2d")!;
    fn();
    this.g = prev;
  }

  /** Depth-sortable furniture rows; sortY sits just in front of the objects' base. */
  propRows(): { row: number; sortY: number; draw: (g: CanvasRenderingContext2D, t: number, dyn: Dyn) => void }[] {
    return [...this.rows].map(([row, layer]) => ({
      row,
      sortY: row * T + 13,
      draw: (g, t, dyn) => {
        g.drawImage(layer.c, 0, layer.y0);
        for (const s of this.seats) {
          if (!s.mon || s.ty - 1 !== row) continue;
          this.monitor(g, s, dyn.seats.get(s.id), t);
          const papers = dyn.desks.get(s.id);
          if (papers) this.deskPapers(g, s, papers);
        }
        this.rowDynamic(row, g, t, dyn);
      },
    }));
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

  spotOwnerOf(id: string) {
    return this.spotOwner.get(id);
  }

  /** claim a free spot of a kind (or a specific spot id); undefined when all are taken */
  claimSpotKind(kind: SpotKind, owner: string, id?: string): Spot | undefined {
    this.releaseSpot(owner);
    const pick = this.spots.find((s) => s.kind === kind && (!id || s.id === id) && !this.spotOwner.has(s.id));
    if (pick) this.spotOwner.set(pick.id, owner);
    return pick;
  }

  randomFreeTileIn(r: { x: number; y: number; w: number; h: number }): Tile {
    for (let i = 0; i < 100; i++) {
      const t = { tx: r.x + Math.floor(Math.random() * r.w), ty: r.y + Math.floor(Math.random() * r.h) };
      if (!this.isBlocked(t.tx, t.ty) && !this.spots.some((s) => s.tx === t.tx && s.ty === t.ty)) return t;
    }
    return this.randomFreeTile();
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

    // boss office (wall decor + low items stay in the background, upright furniture goes to row layers)
    this.whiteboard(2, 4);
    this.poster(102);
    this.onRow(2, () => this.plant(1, 2));
    this.onRow(2, () => this.plant(7, 2));
    this.onRow(3, () => this.rack(8, 2));
    this.onRow(6, () => this.cabinet(1, 6));
    this.onRow(4, () => this.addDesk("boss", "boss", 3, 4, 3));

    // oracle
    this.onRow(2, () => this.plant(11, 2, 1));
    this.onRow(2, () => this.plant(18, 2, 2));
    this.onRow(4, () => this.roundTable(13, 3));
    for (const sx of [13, 14, 15]) this.addSeat("oracle", "table", sx, 5, sx * T + 8, 5 * T + 10);

    // library
    for (let x = 21; x < 31; x++) this.bookshelf(x, 2);
    this.onRow(4, () => this.addDesk("library", "desk", 22, 4));
    this.onRow(4, () => this.addDesk("library", "desk", 27, 4));
    this.onRow(7, () => this.addDesk("library", "desk", 22, 7));
    this.onRow(7, () => this.addDesk("library", "desk", 27, 7));
    this.onRow(4, () => this.globe(25, 4));

    // open plan
    this.onRow(9, () => this.addDesk("open", "desk", 11, 9));
    this.onRow(9, () => this.addDesk("open", "desk", 14, 9));
    this.onRow(9, () => this.addDesk("review", "desk", 17, 9));
    this.onRow(9, () => this.lamp(18, 9));
    this.onRow(12, () => this.addDesk("open", "desk", 11, 12));
    this.onRow(12, () => this.addDesk("open", "desk", 14, 12));
    this.onRow(12, () => this.addDesk("open", "desk", 17, 12));
    this.onRow(8, () => this.plant(20, 8, 1));
    this.onRow(11, () => this.printer(20, 11));
    for (const [x, y] of [[13, 10], [16, 13], [10, 13]] as const) this.bin(x, y);

    // studio
    this.onRow(12, () => this.addDesk("studio", "studio", 2, 12));
    this.onRow(12, () => this.addDesk("studio", "studio", 5, 12));
    this.onRow(15, () => this.addDesk("studio", "studio", 2, 15));
    this.onRow(15, () => this.addDesk("studio", "studio", 5, 15));
    this.onRow(11, () => this.easel(8, 11));
    this.onRow(14, () => this.easel(8, 14, true));

    // workshop
    this.onRow(12, () => this.addDesk("workbench", "bench", 24, 12));
    this.onRow(12, () => this.addDesk("workbench", "bench", 27, 12));
    this.onRow(15, () => this.addDesk("workbench", "bench", 24, 15));
    this.onRow(15, () => this.addDesk("workbench", "bench", 27, 15));
    this.onRow(11, () => this.toolCabinet(30, 10));
    this.onRow(14, () => this.toolCabinet(30, 13));
    this.onRow(17, () => this.crates(23, 17));

    // lounge: kitchenette, TV wall, sofa facing the TV, beanbags, arcade
    this.onRow(15, () => this.counter(10, 15, 3));
    this.onRow(15, () => this.cooler(13, 15));
    this.onRow(17, () => this.tvStand(15, 17));
    this.onRow(16, () => this.arcade(21, 16));
    this.sofaUp(14, 20, 5);
    this.beanbag(12, 19, "#e8590c");
    this.beanbag(20, 19, "#7048e8");
    this.onRow(22, () => this.plant(10, 22, 2));
    this.onRow(22, () => this.plant(21, 22));
    this.onRow(18, () => this.plant(1, 18, 1));
    this.onRow(18, () => this.plant(30, 18, 2));
    const spot = (kind: SpotKind, tx: number, ty: number, face: Pose, sit: boolean, px = tx * T + 8, py = ty * T + 12, via?: Tile) =>
      this.spots.push({ id: `${kind}${tx},${ty}`, kind, tx, ty, px, py, sit, face, via });
    for (const [x, y] of [[11, 16], [12, 16], [14, 16]] as const) spot("coffee", x, y, "up", false);
    // sofa seats are blocked tiles: people step on and off from the row in front (towards the TV)
    for (let x = 14; x <= 18; x++) spot("sofa", x, 20, "up", true, x * T + 8, 20 * T + 9, { tx: x, ty: 19 });
    spot("beanbag", 12, 19, "up", true, 12 * T + 8, 19 * T + 10, { tx: 12, ty: 20 });
    spot("beanbag", 20, 19, "up", true, 20 * T + 8, 19 * T + 10, { tx: 20, ty: 20 });
    spot("arcade", 21, 17, "up", false);

    // cat corner
    this.onRow(20, () => this.catTree(1, 19));
    this.catBed(4, 22);
    this.bowls(6, 21);
    this.yarn(3, 22);
    spot("cat-tree", 2, 19, "down", true, 2 * T + 1, 19 * T + 1, { tx: 3, ty: 20 });
    spot("cat-bed", 4, 22, "down", true, 4 * T + 8, 22 * T + 10);
    spot("cat-food", 5, 21, "right", false, 5 * T + 10, 21 * T + 12);

    // games corner
    this.onRow(20, () => this.pingpongTable(25, 20));
    this.onRow(22, () => this.plant(30, 22, 1));
    this.onRow(22, () => this.crates(23, 22));
    spot("pingpong", 24, 20, "right", false, 24 * T + 10, 20 * T + 12);
    spot("pingpong", 28, 20, "left", false, 28 * T + 6, 20 * T + 12);

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

  private tvStand(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x + 1, y + 2, 3 * T - 2, 12);
    this.r(x + 1, y + 2, 3 * T - 2, 12, "#3b2a20");
    this.r(x + 2, y + 3, 3 * T - 4, 2, "#5c3b24");
    this.r(x + 6, y + 7, 10, 5, "#2b1d14");
    this.r(x + 3 * T - 16, y + 7, 10, 5, "#2b1d14");
    this.r(x + 20, y + 8, 8, 3, "#40c057"); // console light
    // the TV itself: screen faces the sofa (and us)
    this.r(x + 4, y - 20, 3 * T - 8, 23, "#14121c");
    this.r(x + 22, y + 2, 4, 2, "#14121c");
    this.tvScreen = { x: x + 6, y: y - 18, w: 3 * T - 12, h: 19 };
    this.block(tx, ty, 3, 1);
  }

  private arcade(tx: number, ty: number) {
    const x = tx * T + 1;
    const y = ty * T - 12;
    this.shadow(x, y, 14, 26);
    this.r(x, y, 14, 26, "#5f3dc4");
    this.r(x + 1, y + 1, 12, 3, "#ff6b6b");
    this.r(x + 2, y + 5, 10, 9, "#14121c");
    this.r(x, y + 15, 14, 3, "#7048e8");
    this.r(x + 4, y + 14, 1, 2, "#212529");
    this.r(x + 3, y + 13, 3, 1, "#e03131");
    this.r(x + 8, y + 15, 2, 1, "#fcc419");
    this.r(x + 11, y + 15, 2, 1, "#40c057");
    this.arcadeScreen = { x: x + 3, y: y + 6, w: 8, h: 7 };
    this.block(tx, ty);
  }

  /** sofa seen from behind: cushions on the floor layer, backrest in front of the sitters */
  private sofaUp(tx: number, ty: number, w: number) {
    const x = tx * T;
    const y = ty * T;
    rect(this.base, x - 3, y - 2, w * T + 6, 14, "#364fc7");
    rect(this.base, x, y - 1, w * T, 9, "#4263eb");
    for (let i = 1; i < w; i++) rect(this.base, x + i * T, y - 1, 1, 9, "#364fc7");
    this.onRow(ty, () => {
      this.shadow(x - 4, y + 8, w * T + 8, 8);
      this.r(x - 4, y - 3, 4, 18, "#2b3fa8");
      this.r(x + w * T, y - 3, 4, 18, "#2b3fa8");
      this.r(x - 2, y + 8, w * T + 4, 8, "#364fc7");
      this.r(x - 2, y + 8, w * T + 4, 2, "#4c6ef5");
      this.r(x + 6, y + 11, 6, 3, "#ffd43b"); // cushions peeking out
      this.r(x + w * T - 12, y + 11, 6, 3, "#ff8787");
    });
    this.block(tx, ty, w, 1);
  }

  private beanbag(tx: number, ty: number, color: string) {
    const x = tx * T;
    const y = ty * T;
    rect(this.base, x + 1, y + 4, 14, 11, shade(color, -0.3));
    rect(this.base, x + 2, y + 3, 12, 11, color);
    rect(this.base, x + 4, y + 4, 5, 2, shade(color, 0.3));
    this.block(tx, ty);
  }

  private catTree(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x + 1, y + 26, 30, 6);
    this.r(x + 1, y + 26, 30, 6, "#a9743d"); // base
    this.r(x + 1, y + 26, 30, 1, "#c08a4f");
    this.r(x + 14, y + 4, 5, 22, "#d9c39a"); // sisal post
    for (let i = 0; i < 11; i++) this.r(x + 14, y + 5 + i * 2, 5, 1, "#b89a6a");
    this.r(x + 3, y + 1, 26, 4, "#a9743d"); // top platform
    this.r(x + 3, y + 1, 26, 1, "#d6a66e");
    this.r(x + 19, y + 14, 11, 3, "#a9743d"); // side step
    this.r(x + 24, y + 17, 1, 6, "#ff6b6b"); // dangling toy
    this.r(x + 23, y + 23, 3, 3, "#ff6b6b");
    this.block(tx, ty, 2, 2);
  }

  private catBed(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    rect(this.base, x + 1, y + 4, 14, 10, "#c2255c");
    rect(this.base, x + 3, y + 6, 10, 6, "#f783ac");
  }

  private bowls(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    rect(this.base, x + 3, y + 8, 9, 5, "#e8590c");
    rect(this.base, x + 4, y + 8, 7, 2, "#8d5524");
    rect(this.base, x + 5, y + 8, 1, 1, "#c08a4f");
    rect(this.base, x + 3, y + 18, 9, 5, "#1c7ed6");
    rect(this.base, x + 4, y + 18, 7, 2, "#a5d8ff");
  }

  private yarn(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    rect(this.base, x + 4, y + 7, 6, 6, "#e64980");
    rect(this.base, x + 5, y + 8, 2, 1, "#faa2c1");
    rect(this.base, x + 10, y + 11, 4, 1, "#e64980");
  }

  private pingpongTable(tx: number, ty: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x, y - 2, 3 * T, 15);
    this.r(x, y - 2, 3 * T, 13, "#1e6b4a");
    this.r(x + 1, y - 1, 3 * T - 2, 11, "#2b8a3e");
    this.r(x + 1, y + 4, 3 * T - 2, 1, "#e9ecef");
    this.r(x + 1, y - 1, 3 * T - 2, 1, "#e9ecef");
    this.r(x + 1, y + 9, 3 * T - 2, 1, "#e9ecef");
    this.r(x + 24, y - 4, 1, 15, "#f8f9fa"); // net
    this.r(x + 23, y - 4, 3, 1, "#495057");
    this.r(x + 2, y + 11, 2, 3, "#343a40");
    this.r(x + 3 * T - 4, y + 11, 2, 3, "#343a40");
    this.block(tx, ty, 3, 1);
  }

  tvScreen = { x: 0, y: 0, w: 0, h: 0 };
  arcadeScreen = { x: 0, y: 0, w: 0, h: 0 };

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
      this.r(x + 13, y + 3, 7, 3, "#fcc419"); // nameplate (trays left/right are drawn live)
      this.r(x + 14, y + 4, 5, 1, "#1d1a2b");
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
    // chairs are low and get sat on: always part of the floor layer
    rect(this.base, px - 5, py - 7, 10, 7, "#3b3f5c");
    rect(this.base, px - 5, py - 7, 10, 1, "#4c5175");
    this.chairBack(this.base, px, py);
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
    this.whiteboardTodos(g, dyn.todos);
  }

  /** animated details that sit on a furniture row, drawn right after that row layer */
  private rowDynamic(row: number, g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    if (row === 3) this.rackLeds(g, t, dyn);
    if (row === 4) {
      this.crystalBall(g, t, dyn);
      this.trays(g, dyn);
    }
    if (row === 15) this.loungeFx(g, t, dyn);
    if (row === 16) this.arcadeFx(g, t, dyn);
    if (row === 17) this.tvFx(g, t, dyn);
    if (row === 20 && dyn.pingpong) this.pingpongBall(g, dyn.ballT);
  }

  private sheet(g: CanvasRenderingContext2D, x: number, y: number, color = "#f8f9fa") {
    rect(g, x, y, 6, 4, OUT);
    rect(g, x, y, 6, 3, color);
    rect(g, x + 1, y + 1, 3, 1, "#adb5bd");
  }

  /** boss desk: inbox (finished reports, left) and outbox (open assignments, right) */
  private trays(g: CanvasRenderingContext2D, dyn: Dyn) {
    const deskY = 4 * T;
    for (const [tx, n, label] of [[3 * T + 1, dyn.inbox, "#40c057"], [5 * T + 5, dyn.outbox, "#fab005"]] as const) {
      rect(g, tx, deskY + 4, 10, 7, "#495057");
      rect(g, tx + 1, deskY + 5, 8, 5, "#343a40");
      rect(g, tx, deskY + 10, 10, 1, label);
      const k = Math.min(8, n);
      for (let i = 0; i < k; i++) this.sheet(g, tx + 2, deskY + 6 - i, i % 2 ? "#f1f3f5" : "#ffffff");
      if (n > 8) pixelText(g, String(Math.min(99, n)), tx + 1, deskY - 6 - k + 8, "#fff3bf", OUT);
    }
  }

  /** assignment sheet + growing stack of finished pages on a worker desk */
  private deskPapers(g: CanvasRenderingContext2D, s: Seat, p: DeskPapers) {
    const m = s.mon!;
    const deskY = m.y + 1;
    const right = m.x + (s.kind === "boss" ? 14 : 8);
    const k = Math.min(10, p.stack);
    for (let i = 0; i < k; i++) this.sheet(g, right, deskY + 7 - i, i % 3 === 2 ? "#e7f5ff" : "#ffffff");
    if (p.task) {
      const lx = m.x - (s.kind === "boss" ? 20 : 15);
      rect(g, lx, deskY + 3, 7, 8, OUT);
      rect(g, lx, deskY + 3, 7, 7, "#fff3bf");
      rect(g, lx + 1, deskY + 4, 4, 1, "#e03131");
      rect(g, lx + 1, deskY + 6, 5, 1, "#adb5bd");
      rect(g, lx + 1, deskY + 8, 3, 1, "#adb5bd");
    }
  }

  private tvFx(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    const sc = this.tvScreen;
    const show = Math.floor(t / 12) % 3;
    if (show === 0) {
      // cartoon: sky, hills and a bouncing ball
      rect(g, sc.x, sc.y, sc.w, sc.h, "#74c0fc");
      rect(g, sc.x, sc.y + sc.h - 6, sc.w, 6, "#40c057");
      rect(g, sc.x + 5, sc.y + sc.h - 9, 10, 3, "#2f9e44");
      const bx = sc.x + 2 + Math.round(((Math.sin(t * 1.3) + 1) / 2) * (sc.w - 6));
      const by = sc.y + sc.h - 9 - Math.round(Math.abs(Math.sin(t * 4)) * 8);
      rect(g, bx, by, 3, 3, "#e03131");
      rect(g, sc.x + sc.w - 7, sc.y + 2, 4, 4, "#ffe066");
    } else if (show === 1) {
      // cat video
      rect(g, sc.x, sc.y, sc.w, sc.h, "#ffe8cc");
      rect(g, sc.x, sc.y + sc.h - 4, sc.w, 4, "#d9a066");
      const cx = sc.x + 12 + Math.round(Math.sin(t * 0.8) * 6);
      rect(g, cx, sc.y + 7, 9, 6, "#f08c3c");
      rect(g, cx - 3, sc.y + 4, 5, 5, "#f08c3c");
      rect(g, cx - 3, sc.y + 3, 1, 1, "#f08c3c");
      rect(g, cx, sc.y + 3, 1, 1, "#f08c3c");
      rect(g, cx - 2, sc.y + 6, 1, 1, OUT);
      rect(g, cx + 9, sc.y + 5 - (Math.floor(t * 3) % 2), 1, 4, "#f08c3c");
    } else {
      // office news ticker
      rect(g, sc.x, sc.y, sc.w, sc.h, "#1c2541");
      rect(g, sc.x, sc.y, sc.w, 5, "#c92a2a");
      pixelText(g, "NEWS", sc.x + 1, sc.y, "#fff");
      pixelText(g, `${dyn.active} AKTIV`, sc.x + 2, sc.y + 7, "#ffd43b");
      const msg = `+++ ${dyn.inbox} BERICHTE FERTIG +++ ${dyn.outbox} OFFEN +++`;
      const off = Math.floor(t * 12) % (msg.length * 4 + sc.w);
      g.save();
      g.beginPath();
      g.rect(sc.x, sc.y + 13, sc.w, 6);
      g.clip();
      pixelText(g, msg, sc.x + sc.w - off, sc.y + 13, "#e9ecef");
      g.restore();
    }
    if (dyn.tvWatchers === 0) {
      g.globalAlpha = 0.35;
      rect(g, sc.x, sc.y, sc.w, sc.h, "#000");
      g.globalAlpha = 1;
    }
    g.globalAlpha = 0.1;
    rect(g, sc.x, sc.y + (Math.floor(t * 10) % sc.h), sc.w, 1, "#fff");
    g.globalAlpha = 1;
  }

  private arcadeFx(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    const sc = this.arcadeScreen;
    rect(g, sc.x, sc.y, sc.w, sc.h, "#0b0b1a");
    if (dyn.arcade) {
      const k = Math.floor(t * 6);
      rect(g, sc.x + (k % 6), sc.y + 5, 2, 1, "#69db7c");
      rect(g, sc.x + ((k * 3) % 7), sc.y + 1 + ((k >> 1) % 3), 1, 1, "#ff6b6b");
      rect(g, sc.x + 5 - (k % 5), sc.y + 2, 1, 1, "#ffd43b");
    } else if (Math.floor(t * 1.5) % 2) {
      rect(g, sc.x + 1, sc.y + 3, 6, 1, "#7048e8");
    }
  }

  private pingpongBall(g: CanvasRenderingContext2D, k: number) {
    const x0 = 25 * T + 2;
    const x1 = 28 * T - 3;
    const phase = k % 2;
    const u = phase < 1 ? phase : 2 - phase; // there and back
    const x = x0 + (x1 - x0) * u;
    const y = 20 * T + 3 - Math.abs(Math.sin(u * Math.PI)) * 7;
    rect(g, Math.round(x), Math.round(y), 2, 2, "#fff4e6");
  }

  private rackLeds(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
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
  }

  private crystalBall(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
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
  }

  private loungeFx(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
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
      // everything below stays inside the glass
      g.save();
      g.beginPath();
      g.rect(x, 11, 2 * T, 15);
      g.clip();
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
        // clouds drift in from the left edge of the pane and out on the right
        const off = ((t * 2 + tx * 9) % 42) - 9;
        rect(g, x + Math.round(off), 15, 8, 2, "#f8f9fa");
        rect(g, x + Math.round(off) + 2, 14, 4, 1, "#f8f9fa");
        if (tx === WINDOWS[0]) rect(g, x + 4, 13, 4, 4, "#ffe066");
        g.globalAlpha = 1;
      }
      g.restore();
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
    if (st.browsing) {
      rect(g, sx, sy, sw, sh, "#f8f9fa");
      rect(g, sx, sy, sw, 2, "#e64980");
      const k = Math.floor(t / 3) % 3;
      rect(g, sx + 1, sy + 3, 5, 4, ["#ffa94d", "#74c0fc", "#b197fc"][k]);
      rect(g, sx + 7, sy + 3, sw - 8, 1, "#adb5bd");
      rect(g, sx + 7, sy + 5, sw - 10, 1, "#adb5bd");
      return;
    }
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
    const tv = this.tvScreen;
    out.push({ x: tv.x + tv.w / 2, y: tv.y + tv.h, r: 46, color: "#74c0fc", a: dyn.tvWatchers ? 0.5 + Math.sin(t * 7) * 0.05 : 0.25 });
    out.push({ x: this.arcadeScreen.x + 4, y: this.arcadeScreen.y + 8, r: 20, color: "#e64980", a: 0.4 });
    out.push({ x: 26 * T + 8, y: 20 * T + 4, r: 40, color: "#fff3bf", a: 0.35 }); // games lamp
    out.push({ x: 3 * T, y: 21 * T, r: 36, color: "#ffc9c9", a: 0.3 }); // cat corner
    out.push({ x: 232, y: 20, r: 22, color: "#69db7c", a: 0.35 }); // wall TV
    out.push({ x: 8 * T + 8, y: 2 * T + 6, r: 16, color: "#69db7c", a: dyn.bash ? 0.45 : 0.2 }); // rack
    for (const tx of WINDOWS) out.push({ x: tx * T + 16, y: 34, r: 30, color: "#a5b4fc", a: 0.25 }); // moonlight
    out.push({ x: this.door.tx * T + 16, y: H * T - 8, r: 20, color: "#ffe8b0", a: 0.25 });
    return out;
  }
}
