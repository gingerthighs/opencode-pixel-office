// Office layout: walled rooms off a hallway, one desk per staff member, a laptop room for temps.
// Static background is drawn once; upright furniture lives in per-row layers for depth sorting.

import type { AgentStatus, Todo } from "../src/types.ts";
import type { Zone } from "./roles.ts";
import { FONT_H, makeCanvas, pixelText, rect, shade, T, textWidth, type Pose } from "./sprites.ts";

export const W = 32;
export const H = 24;

export interface Tile {
  tx: number;
  ty: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Seat extends Tile {
  id: string;
  zone: Zone;
  kind: "desk" | "boss" | "table" | "bench" | "studio" | "laptop";
  px: number;
  py: number;
  /** screen center (world px), absent for seats without a screen */
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

interface RoomDef extends Rect {
  zone: Zone | "lounge" | "cat" | "games";
  label: string;
  color: string;
  /** sign plaque: center x and top y in world px, mounted on the room's door wall */
  sign: { x: number; y: number };
}

/** Rooms (interior rects, walls excluded). Signs hang on the wall the room's door is in. */
export const ZONES: RoomDef[] = [
  { zone: "boss", label: "CHEFBÜRO", x: 1, y: 2, w: 7, h: 6, color: "#6b2f45", sign: { x: 40, y: 8 * T + 5 } },
  { zone: "oracle", label: "ORAKEL", x: 9, y: 2, w: 5, h: 6, color: "#45366e", sign: { x: 160, y: 8 * T + 5 } },
  { zone: "review", label: "REVIEW", x: 15, y: 2, w: 5, h: 6, color: "#3d4a5c", sign: { x: 256, y: 8 * T + 5 } },
  { zone: "library", label: "BIBLIOTHEK", x: 21, y: 2, w: 10, h: 6, color: "#2c5a4a", sign: { x: 384, y: 8 * T + 5 } },
  { zone: "studio", label: "STUDIO", x: 1, y: 12, w: 6, h: 4, color: "#285866", sign: { x: 48, y: 11 * T + 5 } },
  { zone: "workbench", label: "WERKSTATT", x: 8, y: 12, w: 6, h: 4, color: "#5a4b3c", sign: { x: 200, y: 11 * T + 5 } },
  { zone: "temp", label: "AUSHILFEN", x: 18, y: 12, w: 13, h: 4, color: "#4b4330", sign: { x: 392, y: 11 * T + 5 } },
  { zone: "cat", label: "KATZENECKE", x: 1, y: 17, w: 6, h: 6, color: "#5a3550", sign: { x: 76, y: 16 * T + 5 } },
  { zone: "games", label: "SPIELECKE", x: 8, y: 17, w: 6, h: 6, color: "#2e4d3c", sign: { x: 176, y: 16 * T + 5 } },
  { zone: "lounge", label: "LOUNGE", x: 18, y: 17, w: 13, h: 6, color: "#3b4561", sign: { x: 470, y: 16 * T + 5 } },
];

/** interior walls: horizontal runs (y, x0..x1) and vertical runs (x, y0..y1) with door tiles left open */
const H_WALLS: { y: number; x0: number; x1: number; doors: number[] }[] = [
  { y: 8, x0: 1, x1: 30, doors: [4, 11, 17, 27] },
  { y: 11, x0: 1, x1: 14, doors: [5, 10] },
  { y: 11, x0: 17, x1: 30, doors: [] },
  { y: 16, x0: 1, x1: 14, doors: [] },
  { y: 16, x0: 17, x1: 30, doors: [24] },
];
const V_WALLS: { x: number; y0: number; y1: number; doors: number[] }[] = [
  { x: 8, y0: 2, y1: 7, doors: [] },
  { x: 14, y0: 2, y1: 7, doors: [] },
  { x: 20, y0: 2, y1: 7, doors: [] },
  { x: 7, y0: 12, y1: 22, doors: [19] },
  { x: 14, y0: 12, y1: 22, doors: [19] },
  { x: 17, y0: 12, y1: 22, doors: [13, 19] },
];

const WALL_TOP = "#231f33";
const WALL_FACE = "#4a4462";
const FLOOR = "#8a5b3c";
const OUT = "#16121f";
const WINDOWS = [10, 16];
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

type Fx = (g: CanvasRenderingContext2D, t: number, dyn: Dyn) => void;

export class Office {
  readonly bg: HTMLCanvasElement;
  readonly seats: Seat[] = [];
  readonly spots: Spot[] = [];
  readonly door: Tile = { tx: 15, ty: H - 1 };
  /** where workers fetch assignments (outbox, right of the boss desk) and drop reports (inbox, left) */
  readonly pickup: (Tile & { face: Pose })[] = [{ tx: 6, ty: 4, face: "left" }, { tx: 6, ty: 5, face: "up" }, { tx: 7, ty: 4, face: "left" }];
  readonly dropoff: (Tile & { face: Pose })[] = [{ tx: 2, ty: 4, face: "right" }, { tx: 2, ty: 5, face: "up" }, { tx: 2, ty: 3, face: "down" }];
  readonly lounge: Rect = { x: 18, y: 17, w: 13, h: 6 };
  readonly hall: Rect = { x: 1, y: 9, w: 30, h: 2 };
  readonly tempArea: Rect = { x: 18, y: 14, w: 13, h: 2 };
  readonly catArea: Rect = { x: 1, y: 17, w: 6, h: 6 };
  /** zone signs in world pixels (3×5 font) — used when the view is zoomed in enough to read them */
  readonly signLayer: HTMLCanvasElement;
  tvScreen: Rect = { x: 0, y: 0, w: 0, h: 0 };
  arcadeScreen: Rect = { x: 0, y: 0, w: 0, h: 0 };
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
  /** animated details drawn right after their furniture row */
  private fx = new Map<number, Fx[]>();
  private lightsStatic: Light[] = [];
  private pong = { x0: 0, x1: 0, y: 0 };
  private rackAt = { x: 0, y: 0 };
  private ballAt = { x: 0, y: 0 };
  private candles: { x: number; y: number }[] = [];
  private coffeeAt = { x: 0, y: 0 };
  private coolerAt = { x: 0, y: 0 };
  private clockAt = { x: 0, y: 0 };

  constructor() {
    const [c, g] = makeCanvas(W * T, H * T);
    this.bg = c;
    this.g = g;
    this.base = g;
    const [sc, sg] = makeCanvas(W * T, H * T);
    this.signLayer = sc;
    this.build();
    for (const z of ZONES) this.sign(sg, z.label, z.sign.x, z.sign.y);
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

  private addFx(row: number, fn: Fx) {
    const list = this.fx.get(row) ?? [];
    list.push(fn);
    this.fx.set(row, list);
    if (!this.rows.has(row)) this.onRow(row, () => {});
  }

  /** Depth-sortable furniture rows; sortY sits just in front of the objects' base. */
  propRows(): { row: number; sortY: number; draw: Fx }[] {
    return [...this.rows].map(([row, layer]) => ({
      row,
      sortY: row * T + 13,
      draw: (g, t, dyn) => {
        g.drawImage(layer.c, 0, layer.y0);
        for (const s of this.seats) {
          if (!s.mon || s.ty - 1 !== row) continue;
          if (s.kind === "laptop") this.laptop(g, s, dyn.seats.get(s.id), t);
          else this.monitor(g, s, dyn.seats.get(s.id), t);
          const papers = dyn.desks.get(s.id);
          if (papers) this.deskPapers(g, s, papers);
        }
        for (const f of this.fx.get(row) ?? []) f(g, t, dyn);
      },
    }));
  }

  // ---------- allocation ----------

  /** a free seat of exactly this zone — everybody has their own desk, temps only use laptop seats */
  claimSeat(zone: Zone, owner: string): Seat | undefined {
    const existing = this.seatOf(owner);
    if (existing) return existing;
    const pick = this.seats.find((s) => s.zone === zone && !this.seatOwner.has(s.id));
    if (pick) this.seatOwner.set(pick.id, owner);
    return pick;
  }

  seatOf(owner: string): Seat | undefined {
    for (const [sid, o] of this.seatOwner) if (o === owner) return this.seats.find((s) => s.id === sid);
  }

  releaseSeat(owner: string) {
    for (const [sid, o] of this.seatOwner) if (o === owner) this.seatOwner.delete(sid);
  }

  releaseSpot(owner: string) {
    for (const [sid, o] of this.spotOwner) if (o === owner) this.spotOwner.delete(sid);
  }

  isSpotTaken(id: string) {
    return this.spotOwner.has(id);
  }

  /** claim a free spot of a kind; undefined when all are taken */
  claimSpotKind(kind: SpotKind, owner: string): Spot | undefined {
    this.releaseSpot(owner);
    const free = this.spots.filter((s) => s.kind === kind && !this.spotOwner.has(s.id));
    const pick = free[Math.floor(Math.random() * free.length)];
    if (pick) this.spotOwner.set(pick.id, owner);
    return pick;
  }

  randomFreeTileIn(r: Rect): Tile {
    for (let i = 0; i < 100; i++) {
      const t = { tx: r.x + Math.floor(Math.random() * r.w), ty: r.y + Math.floor(Math.random() * r.h) };
      if (!this.isBlocked(t.tx, t.ty) && !this.spots.some((s) => s.tx === t.tx && s.ty === t.ty) && !this.isDoor(t)) return t;
    }
    return this.randomFreeTile();
  }

  // ---------- pathing ----------

  isBlocked(tx: number, ty: number) {
    return tx < 0 || ty < 0 || tx >= W || ty >= H || this.blocked[ty * W + tx] === 1;
  }

  private isDoor(t: Tile) {
    return H_WALLS.some((w) => w.y === t.ty && w.doors.includes(t.tx)) || V_WALLS.some((w) => w.x === t.tx && w.doors.includes(t.ty));
  }

  randomFreeTile(): Tile {
    for (let i = 0; i < 200; i++) {
      const t = { tx: 1 + Math.floor(Math.random() * (W - 2)), ty: 2 + Math.floor(Math.random() * (H - 3)) };
      if (!this.isBlocked(t.tx, t.ty) && !this.isDoor(t)) return t;
    }
    return { tx: 15, ty: 10 };
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

  private spot(kind: SpotKind, tx: number, ty: number, face: Pose, sit: boolean, px = tx * T + 8, py = ty * T + 12, via?: Tile) {
    this.spots.push({ id: `${kind}${tx},${ty}`, kind, tx, ty, px, py, sit, face, via });
  }

  private build() {
    this.floor();
    this.stoneFloor(this.hall);
    this.stoneFloor({ x: 15, y: 11, w: 2, h: 12 });
    for (const z of ZONES) this.carpet(z.x, z.y, z.w, z.h, z.color);
    this.outerWalls();
    this.interiorWalls();

    // --- boss office ---
    this.whiteboard(2, 4);
    this.onRow(2, () => this.plant(1, 2));
    this.onRow(3, () => this.rack(7, 2));
    this.onRow(6, () => this.cabinet(1, 6));
    this.onRow(7, () => this.plant(7, 7, 2));
    this.onRow(4, () => this.addDesk("boss", "boss", 3, 4, 3));
    this.addFx(3, (g, t, dyn) => this.rackLeds(g, t, dyn));
    this.addFx(4, (g, _t, dyn) => this.trays(g, dyn));
    this.lightsStatic.push({ x: 7 * T + 8, y: 2 * T + 6, r: 16, color: "#69db7c", a: 0.2 });

    // --- oracle ---
    this.poster(196);
    this.onRow(2, () => this.plant(9, 2, 1));
    this.onRow(2, () => this.plant(13, 2, 2));
    this.onRow(4, () => this.roundTable(10, 3));
    this.addSeat("oracle", "table", 11, 5, 11 * T + 8, 5 * T + 10);
    this.onRow(7, () => this.plant(13, 7));
    this.addFx(4, (g, t, dyn) => this.crystalBall(g, t, dyn));

    // --- review ---
    this.clockFace(18);
    this.onRow(2, () => this.plant(15, 2));
    this.onRow(2, () => this.bookshelf(19, 2));
    this.onRow(4, () => this.addDesk("review", "desk", 16, 4));
    this.onRow(4, () => this.lamp(17, 4));
    this.lightsStatic.push({ x: 17 * T + 11, y: 4 * T - 4, r: 28, color: "#fff3bf", a: 0.5 });
    this.onRow(7, () => this.plant(19, 7, 1));

    // --- library: three desks (Ella, Emil, Lotte) ---
    for (let x = 21; x <= 30; x++) this.onRow(2, () => this.bookshelf(x, 2));
    this.onRow(4, () => this.addDesk("library", "desk", 22, 4));
    this.onRow(4, () => this.addDesk("library", "desk", 27, 4));
    this.onRow(6, () => this.addDesk("library", "desk", 23, 6));
    this.onRow(6, () => this.globe(30, 6));
    this.onRow(7, () => this.plant(21, 7, 2));

    // --- hallway ---
    // plants sit in the lower hallway row so their leaves never cover the door signs
    this.onRow(10, () => this.plant(1, 10, 2));
    this.onRow(10, () => this.plant(30, 10));
    this.onRow(10, () => this.printer(20, 10));
    this.bench(8, 9, 2);

    // --- studio (Dani) ---
    this.onRow(13, () => this.addDesk("studio", "studio", 2, 13));
    this.onRow(12, () => this.easel(6, 12));
    this.onRow(14, () => this.easel(6, 14, true));
    this.onRow(14, () => this.plant(1, 14, 1));
    this.onRow(15, () => this.plant(1, 15, 2));

    // --- workshop (Fritz, Frieda) ---
    this.onRow(13, () => this.addDesk("workbench", "bench", 8, 13));
    this.onRow(13, () => this.addDesk("workbench", "bench", 11, 13));
    this.onRow(15, () => this.toolCabinet(13, 14));
    this.onRow(15, () => this.crates(8, 15));

    // --- temps: one long table with laptops ---
    this.onRow(13, () => this.laptopTable(19, 13, 11));
    for (const x of [20, 22, 24, 26, 28]) this.addSeat("temp", "laptop", x, 14, x * T + 8, 14 * T + 10, { x: x * T + 8, y: 13 * T, w: 12 });
    this.onRow(12, () => this.plant(30, 12));
    this.onRow(15, () => this.cooler(30, 15));

    // --- cat corner ---
    this.onRow(18, () => this.catTree(1, 17));
    this.catBed(4, 21);
    this.bowls(6, 20);
    this.yarn(3, 22);
    this.spot("cat-tree", 2, 17, "down", true, 2 * T + 1, 17 * T + 1, { tx: 3, ty: 18 });
    this.spot("cat-bed", 4, 21, "down", true, 4 * T + 8, 21 * T + 10);
    this.spot("cat-food", 5, 20, "right", false, 5 * T + 10, 20 * T + 12);
    this.lightsStatic.push({ x: 3 * T, y: 19 * T, r: 36, color: "#ffc9c9", a: 0.3 });

    // --- games corner ---
    this.onRow(19, () => this.pingpongTable(9, 19));
    this.pong = { x0: 9 * T + 2, x1: 12 * T - 3, y: 19 * T + 3 };
    this.spot("pingpong", 8, 19, "right", false, 8 * T + 10, 19 * T + 12);
    this.spot("pingpong", 12, 19, "left", false, 12 * T + 6, 19 * T + 12);
    this.onRow(17, () => this.arcade(13, 17));
    this.spot("arcade", 13, 18, "up", false);
    this.onRow(22, () => this.plant(8, 22, 1));
    this.onRow(22, () => this.plant(13, 22));
    this.addFx(19, (g, _t, dyn) => dyn.pingpong && this.pingpongBall(g, dyn.ballT));
    this.addFx(17, (g, t, dyn) => this.arcadeFx(g, t, dyn));
    this.lightsStatic.push({ x: 10 * T + 8, y: 19 * T, r: 40, color: "#fff3bf", a: 0.35 });

    // --- lounge: kitchenette, TV, sofa facing it, beanbags ---
    this.onRow(17, () => this.counter(18, 17, 3));
    this.onRow(17, () => this.cooler(21, 17));
    this.onRow(17, () => this.tvStand(25, 17));
    this.sofaUp(24, 20, 5);
    this.beanbag(22, 19, "#e8590c");
    this.beanbag(30, 19, "#7048e8");
    this.onRow(22, () => this.plant(18, 22, 2));
    this.onRow(22, () => this.plant(30, 22));
    for (const x of [19, 20]) this.spot("coffee", x, 18, "up", false);
    this.spot("coffee", 21, 18, "up", false);
    // sofa seats are blocked tiles: people step on and off from the row in front (towards the TV)
    for (let x = 24; x <= 28; x++) this.spot("sofa", x, 20, "up", true, x * T + 8, 20 * T + 9, { tx: x, ty: 19 });
    this.spot("beanbag", 22, 19, "up", true, 22 * T + 8, 19 * T + 10, { tx: 22, ty: 20 });
    this.spot("beanbag", 30, 19, "up", true, 30 * T + 8, 19 * T + 10, { tx: 30, ty: 20 });
    this.addFx(17, (g, t, dyn) => this.loungeFx(g, t, dyn));
    this.addFx(17, (g, t, dyn) => this.tvFx(g, t, dyn));
  }

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

  /** checkered stone tiles for the hallway and corridor */
  private stoneFloor(r: Rect) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = (x + y) % 2 ? "#8f8a9e" : "#a39eb1";
        this.r(x * T, y * T, T, T, c);
        this.r(x * T, y * T, T, 1, shade(c, 0.12));
        this.r(x * T, y * T + 15, T, 1, shade(c, -0.15));
        if ((x * 5 + y * 3) % 4 === 0) this.r(x * T + 4, y * T + 6, 3, 1, shade(c, -0.08));
      }
    }
  }

  private carpet(x: number, y: number, w: number, h: number, c: string) {
    const px = x * T + 1;
    const py = y * T + 1;
    const pw = w * T - 2;
    const ph = h * T - 2;
    this.r(px, py, pw, ph, shade(c, -0.25));
    this.r(px + 1, py + 1, pw - 2, ph - 2, c);
    const trim = shade(c, 0.18);
    this.r(px + 3, py + 3, pw - 6, 1, trim);
    this.r(px + 3, py + ph - 4, pw - 6, 1, trim);
    this.r(px + 3, py + 3, 1, ph - 6, trim);
    this.r(px + pw - 4, py + 3, 1, ph - 6, trim);
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
    g.globalAlpha = 0.3;
    rect(g, x + 1, top + 2, w, h, "#000");
    g.globalAlpha = 1;
    rect(g, x, top, w, h, SIGN_RIM);
    rect(g, x + 1, top + 1, w - 2, h - 2, SIGN_BG);
    rect(g, x + 1, top + 1, w - 2, 1, "#3a3150");
    rect(g, x, top, 1, 1, OUT);
    rect(g, x + w - 1, top, 1, 1, OUT);
    pixelText(g, label, x + 4, top + 3, SIGN_TEXT, "#120e1c");
  }

  private outerWalls() {
    this.r(0, 0, W * T, 9, WALL_TOP);
    this.r(0, 9, W * T, 21, WALL_FACE);
    for (let x = 0; x < W * T; x += 32) this.r(x, 9, 1, 21, shade(WALL_FACE, -0.12));
    this.r(0, 9, W * T, 1, shade(WALL_FACE, 0.15));
    this.r(0, 28, W * T, 4, shade(WALL_FACE, -0.35));
    this.r(0, 28, W * T, 1, shade(WALL_FACE, -0.15));
    for (const wx of WINDOWS) this.windowFrame(wx);
    this.block(0, 0, W, 2);
    this.r(0, 0, 10, H * T, WALL_TOP);
    this.r(10, 32, 2, H * T - 48, shade(WALL_TOP, 0.15));
    this.r(W * T - 10, 0, 10, H * T, WALL_TOP);
    this.r(W * T - 12, 32, 2, H * T - 48, shade(WALL_TOP, 0.15));
    this.block(0, 0, 1, H);
    this.block(W - 1, 0, 1, H);
    this.r(0, (H - 1) * T + 6, W * T, 10, WALL_TOP);
    this.r(0, (H - 1) * T + 4, W * T, 2, shade(WALL_TOP, 0.15));
    this.block(0, H - 1, W, 1);
    // entrance with mat
    const d = this.door;
    this.r(d.tx * T, (H - 1) * T, 2 * T, T, "#a39eb1");
    this.r(d.tx * T - 2, (H - 1) * T + 2, 2, 14, "#5b4a6e");
    this.r(d.tx * T + 2 * T, (H - 1) * T + 2, 2, 14, "#5b4a6e");
    this.r(d.tx * T + 3, (H - 1) * T + 2, 2 * T - 6, 11, "#5b3a29");
    for (let i = 0; i < 4; i++) this.r(d.tx * T + 6 + i * 6, (H - 1) * T + 4, 3, 7, "#7a5236");
    this.blocked[(H - 1) * W + d.tx] = 0;
    this.blocked[(H - 1) * W + d.tx + 1] = 0;
    this.lightsStatic.push({ x: d.tx * T + 16, y: H * T - 8, r: 20, color: "#ffe8b0", a: 0.25 });
  }

  /** Room walls: horizontal runs show a cap and a front face, vertical runs a slimmer cap. */
  private interiorWalls() {
    const isWall = (x: number, y: number) =>
      H_WALLS.some((w) => w.y === y && x >= w.x0 && x <= w.x1 && !w.doors.includes(x)) ||
      V_WALLS.some((w) => w.x === x && y >= w.y0 && y <= w.y1 && !w.doors.includes(y));
    for (const w of V_WALLS) {
      for (let y = w.y0; y <= w.y1; y++) {
        const px = w.x * T;
        const py = y * T;
        if (w.doors.includes(y)) {
          this.doorway(px, py, "v");
          continue;
        }
        this.r(px + 4, py, 8, T, WALL_TOP);
        this.r(px + 4, py, 1, T, shade(WALL_TOP, 0.25));
        this.r(px + 11, py, 1, T, shade(WALL_TOP, -0.3));
        this.g.globalAlpha = 0.2;
        this.r(px + 12, py, 2, T, "#000");
        this.g.globalAlpha = 1;
        this.block(w.x, y);
      }
    }
    for (const w of H_WALLS) {
      for (let x = w.x0; x <= w.x1; x++) {
        const px = x * T;
        const py = w.y * T;
        if (w.doors.includes(x)) {
          this.doorway(px, py, "h");
          continue;
        }
        // cap on top, face towards the room below
        this.r(px, py, T, 6, WALL_TOP);
        this.r(px, py + 6, T, 10, WALL_FACE);
        this.r(px, py + 6, T, 1, shade(WALL_FACE, 0.18));
        this.r(px, py + 14, T, 2, shade(WALL_FACE, -0.35));
        if (x % 2 === 0) this.r(px, py + 6, 1, 8, shade(WALL_FACE, -0.12));
        // vertical wall meeting from above/below: keep the cap continuous
        if (isWall(x, w.y - 1) && V_WALLS.some((v) => v.x === x)) this.r(px + 4, py, 8, 6, WALL_TOP);
        this.block(x, w.y);
      }
    }
  }

  private doorway(px: number, py: number, dir: "h" | "v") {
    if (dir === "h") {
      // door frame posts + an opened door leaf against the left post
      this.r(px - 1, py, 2, T, "#2b2438");
      this.r(px + T - 1, py, 2, T, "#2b2438");
      this.r(px + 1, py + 13, T - 2, 3, "#5c4a3a");
      this.r(px + 1, py, 3, 12, "#8d6e63");
      this.r(px + 2, py + 5, 1, 2, "#fcc419");
    } else {
      this.r(px + 4, py - 1, 8, 2, "#2b2438");
      this.r(px + 4, py + T - 1, 8, 2, "#2b2438");
      this.r(px + 5, py + 1, 6, T - 2, "#5c4a3a");
      this.g.globalAlpha = 0.5;
      this.r(px + 6, py + 2, 4, T - 4, "#7a5236");
      this.g.globalAlpha = 1;
    }
  }

  private windowFrame(tx: number) {
    const x = tx * T;
    this.r(x - 1, 10, 2 * T + 2, 17, "#2a2540");
    this.r(x, 26, 2 * T, 2, "#6c6488");
    this.r(x - 2, 27, 2 * T + 4, 1, "#857da3");
  }

  private clockFace(tx: number) {
    const x = tx * T + 3;
    this.r(x, 11, 11, 11, "#ced4da");
    this.r(x + 1, 12, 9, 9, "#fff");
    this.r(x + 5, 12, 1, 1, "#868e96");
    this.r(x + 5, 20, 1, 1, "#868e96");
    this.r(x + 1, 16, 1, 1, "#868e96");
    this.r(x + 9, 16, 1, 1, "#868e96");
    this.clockAt = { x: x + 5, y: 16 };
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
      this.r(x + 6, y - 1, 4, 10, "#2f9e44");
      this.r(x + 3, y + 2, 3, 2, "#2f9e44");
      this.r(x + 3, y, 2, 3, "#2f9e44");
      this.r(x + 10, y + 3, 3, 2, "#2f9e44");
      this.r(x + 11, y + 1, 2, 3, "#2f9e44");
      this.r(x + 7, y, 1, 8, "#51cf66");
      this.r(x + 7, y - 2, 2, 1, "#ff8787");
    } else if (variant === 2) {
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
    this.rackAt = { x: x + 3, y: y + 4 };
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
    this.r(x + 7, y + 14, 4, 6, "#f1f3f5");
    this.r(x + 8, y + 15, 2, 4, "#7048e8");
    this.r(x + 36, y + 13, 4, 6, "#f1f3f5");
    this.r(x + 37, y + 14, 2, 4, "#e03131");
    this.r(x + 6, y + 6, 2, 4, "#fff3bf");
    this.r(x + 40, y + 6, 2, 4, "#fff3bf");
    this.r(x + 20, y + 16, 8, 3, "#c5a46d");
    this.ballAt = { x: x + 24, y: y + 26 };
    this.candles = [
      { x: x + 7, y: y + 5 },
      { x: x + 41, y: y + 5 },
    ];
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

  /** low waiting bench against the hallway wall (floor layer, not blocking) */
  private bench(tx: number, ty: number, w: number) {
    const x = tx * T + 1;
    const y = ty * T + 2;
    rect(this.base, x, y, w * T - 2, 6, "#7a5236");
    rect(this.base, x, y, w * T - 2, 1, "#a9743d");
    rect(this.base, x + 1, y + 6, 2, 3, "#3b2a20");
    rect(this.base, x + w * T - 5, y + 6, 2, 3, "#3b2a20");
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

  /** long shared table for temps; laptops are drawn live per seat */
  private laptopTable(tx: number, ty: number, w: number) {
    const x = tx * T;
    const y = ty * T;
    const top = "#b98a5a";
    this.shadow(x, y + 1, w * T, 17);
    this.r(x, y + 1, w * T, 11, top);
    this.r(x, y + 1, w * T, 1, shade(top, 0.2));
    this.r(x, y + 12, w * T, 4, shade(top, -0.35));
    for (let i = 0; i < w; i += 3) this.r(x + i * T + 2, y + 16, 2, 2, "#3b2a20");
    // shared stuff: power strip, cables, a coffee pot
    this.r(x + 6, y + 3, 10, 2, "#343a40");
    this.r(x + w * T - 14, y + 3, 6, 6, "#e9ecef");
    this.r(x + w * T - 13, y + 2, 4, 1, "#868e96");
    this.block(tx, ty, w, 1);
  }

  private counter(tx: number, ty: number, w: number) {
    const x = tx * T;
    const y = ty * T;
    this.shadow(x, y - 2, w * T, 18);
    this.r(x, y - 2, w * T, 12, "#dee2e6");
    this.r(x, y + 10, w * T, 6, "#868e96");
    this.r(x, y - 2, w * T, 1, "#f8f9fa");
    for (let i = 1; i < w; i++) this.r(x + i * T, y + 10, 1, 6, "#6c757d");
    const cx = x + T + 2;
    this.r(cx, y - 12, 12, 14, "#343a40");
    this.r(cx + 1, y - 11, 10, 4, "#495057");
    this.r(cx + 8, y - 10, 2, 2, "#ff6b6b");
    this.r(cx + 4, y - 4, 4, 1, "#212529");
    this.r(cx + 4, y - 2, 4, 3, "#f8f9fa");
    this.coffeeAt = { x: cx + 6, y: y - 6 };
    this.r(x + 4, y + 1, 3, 3, "#ff922b");
    this.r(x + 2 * T + 3, y + 1, 3, 3, "#4dabf7");
    this.r(x + 2 * T + 9, y, 5, 3, "#e9ecef");
    this.r(x + 2 * T + 10, y - 1, 2, 2, "#fab005");
    this.r(x + 2 * T + 12, y - 1, 2, 2, "#e03131");
    this.lightsStatic.push({ x: cx + 6, y: y - 6, r: 16, color: "#ff8787", a: 0.3 });
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
    this.coolerAt = { x: x + 4, y: y + 8 };
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
    this.r(x + 20, y + 8, 8, 3, "#40c057");
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
      this.r(x + 6, y + 11, 6, 3, "#ffd43b");
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
    this.r(x + 1, y + 26, 30, 6, "#a9743d");
    this.r(x + 1, y + 26, 30, 1, "#c08a4f");
    this.r(x + 14, y + 4, 5, 22, "#d9c39a");
    for (let i = 0; i < 11; i++) this.r(x + 14, y + 5 + i * 2, 5, 1, "#b89a6a");
    this.r(x + 3, y + 1, 26, 4, "#a9743d");
    this.r(x + 3, y + 1, 26, 1, "#d6a66e");
    this.r(x + 19, y + 14, 11, 3, "#a9743d");
    this.r(x + 24, y + 17, 1, 6, "#ff6b6b");
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
    this.r(x + 24, y - 4, 1, 15, "#f8f9fa");
    this.r(x + 23, y - 4, 3, 1, "#495057");
    this.r(x + 2, y + 11, 2, 3, "#343a40");
    this.r(x + 3 * T - 4, y + 11, 2, 3, "#343a40");
    this.block(tx, ty, 3, 1);
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
    this.r(cx + 7, y + 9, 2, 2, "#adb5bd");
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
      this.r(x + 13, y + 3, 7, 3, "#fcc419");
      this.r(x + 14, y + 4, 5, 1, "#1d1a2b");
    } else {
      // personal touch: mug, family photo or a tiny plant, depending on the desk
      const k = (dx * 7 + dy * 3) % 3;
      if (k === 0) this.r(x + 3, y + 4, 3, 3, "#ff922b");
      if (k === 1) {
        this.r(x + 2, y + 3, 5, 4, "#e9ecef");
        this.r(x + 3, y + 4, 3, 2, "#74c0fc");
      }
      if (k === 2) this.r(x + 4, y + 2, 2, 4, "#40c057");
    }
    this.block(dx, dy, w, 1);
    const sx = Math.floor(cx / T);
    const monW = kind === "boss" ? 20 : 14;
    this.addSeat(zone, kind, sx, dy + 1, cx, (dy + 1) * T + 10, { x: cx, y: y - 1, w: monW });
  }

  private addSeat(zone: Zone, kind: Seat["kind"], tx: number, ty: number, px: number, py: number, mon?: Seat["mon"]) {
    // chairs (stools for laptop seats) are low and get sat on: always part of the floor layer
    if (kind === "laptop") {
      rect(this.base, px - 4, py - 6, 8, 6, "#5c4a3a");
      rect(this.base, px - 4, py - 6, 8, 1, "#7a6550");
    } else {
      rect(this.base, px - 5, py - 7, 10, 7, "#3b3f5c");
      rect(this.base, px - 5, py - 7, 10, 1, "#4c5175");
      this.chairBack(this.base, px, py);
    }
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
    this.clockHands(g);
    this.whiteboardTodos(g, dyn.todos);
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
    const deskY = s.kind === "laptop" ? m.y : m.y + 1;
    const right = m.x + (s.kind === "boss" ? 14 : s.kind === "laptop" ? 7 : 8);
    const k = Math.min(10, p.stack);
    for (let i = 0; i < k; i++) this.sheet(g, right, deskY + 7 - i, i % 3 === 2 ? "#e7f5ff" : "#ffffff");
    if (p.task) {
      const lx = m.x - (s.kind === "boss" ? 20 : s.kind === "laptop" ? 13 : 15);
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
      rect(g, sc.x, sc.y, sc.w, sc.h, "#74c0fc");
      rect(g, sc.x, sc.y + sc.h - 6, sc.w, 6, "#40c057");
      rect(g, sc.x + 5, sc.y + sc.h - 9, 10, 3, "#2f9e44");
      const bx = sc.x + 2 + Math.round(((Math.sin(t * 1.3) + 1) / 2) * (sc.w - 6));
      const by = sc.y + sc.h - 9 - Math.round(Math.abs(Math.sin(t * 4)) * 8);
      rect(g, bx, by, 3, 3, "#e03131");
      rect(g, sc.x + sc.w - 7, sc.y + 2, 4, 4, "#ffe066");
    } else if (show === 1) {
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
      // office news: live numbers
      rect(g, sc.x, sc.y, sc.w, sc.h, "#1c2541");
      rect(g, sc.x, sc.y, sc.w, 5, "#c92a2a");
      pixelText(g, "NEWS", sc.x + 1, sc.y, "#fff");
      const tk = dyn.tokens;
      const tok = tk >= 1e6 ? (tk / 1e6).toFixed(1) + "M" : tk >= 1e3 ? Math.round(tk / 1e3) + "K" : String(tk);
      pixelText(g, `${dyn.active} AKTIV`, sc.x + 2, sc.y + 7, "#ffd43b");
      const msg = `+++ ${dyn.inbox} BERICHTE FERTIG +++ ${dyn.outbox} OFFEN +++ ${tok} TOKENS +++`;
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
    const { x0, x1, y } = this.pong;
    const phase = k % 2;
    const u = phase < 1 ? phase : 2 - phase;
    const x = x0 + (x1 - x0) * u;
    rect(g, Math.round(x), Math.round(y - Math.abs(Math.sin(u * Math.PI)) * 7), 2, 2, "#fff4e6");
  }

  private rackLeds(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    const { x: rx, y: ry } = this.rackAt;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const speed = dyn.bash ? 9 : 1.5;
        const on = Math.sin(t * speed + i * 1.7 + j * 2.3) > (dyn.bash ? -0.2 : 0.4);
        rect(g, rx + j * 3, ry + i * 6, 2, 1, on ? (j === 2 ? "#ffa94d" : "#69db7c") : "#2f3a2f");
      }
    }
  }

  private crystalBall(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    const { x: bx, y: by } = this.ballAt;
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
    for (const c of this.candles) {
      const f = Math.sin(t * 13 + c.x) > 0 ? 1 : 0;
      rect(g, c.x, c.y - 1 - f, 1, 2, "#ffa94d");
      rect(g, c.x, c.y, 1, 1, "#fff3bf");
    }
  }

  private loungeFx(g: CanvasRenderingContext2D, t: number, dyn: Dyn) {
    if (dyn.lounge) {
      const { x: cx, y: cy } = this.coffeeAt;
      for (let i = 0; i < 3; i++) {
        const k = (t * 0.8 + i / 3) % 1;
        g.globalAlpha = 1 - k;
        rect(g, cx + Math.round(Math.sin(k * 6 + i) * 2), cy - Math.round(k * 10), 1, 2, "#f1f3f5");
      }
      g.globalAlpha = 1;
    }
    const bk = (t * 0.35) % 1;
    if (bk < 0.5) rect(g, this.coolerAt.x, this.coolerAt.y - Math.round(bk * 14), 1, 1, "#e7f5ff");
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
        const off = ((t * 2 + tx * 9) % 42) - 9;
        rect(g, x + Math.round(off), 15, 8, 2, "#f8f9fa");
        rect(g, x + Math.round(off) + 2, 14, 4, 1, "#f8f9fa");
        if (tx === WINDOWS[0]) rect(g, x + 4, 13, 4, 4, "#ffe066");
        g.globalAlpha = 1;
      }
      g.restore();
      rect(g, x + 15, 11, 2, 15, "#2a2540");
      rect(g, x, 18, 2 * T, 1, "#2a2540");
    }
  }

  private clockHands(g: CanvasRenderingContext2D) {
    const now = new Date();
    const { x: cx, y: cy } = this.clockAt;
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

  /** screen content shared by monitors and laptops */
  private screen(g: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number, st: SeatState | undefined, t: number) {
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
      rect(g, sx + 1, sy + 3, Math.min(5, sw - 3), sh - 4, ["#ffa94d", "#74c0fc", "#b197fc"][k]);
      if (sw > 9) {
        rect(g, sx + 7, sy + 3, sw - 8, 1, "#adb5bd");
        rect(g, sx + 7, sy + 5, sw - 10, 1, "#adb5bd");
      }
      return;
    }
    if (st.status === "busy" || st.status === "retry") {
      const tool = st.tool ?? "";
      if (/web|fetch|search|context7|exa/.test(tool)) {
        rect(g, sx, sy, sw, 2, "#dee2e6");
        rect(g, sx + 1, sy + 3, sw - 2, 1, "#74c0fc");
        rect(g, sx + 1, sy + 5, sw - 5, 1, "#868e96");
        if (sh > 7) rect(g, sx + 1, sy + 7, Math.round((sw - 4) * ((t * 0.7) % 1)), 1, "#868e96");
        return;
      }
      const term = /bash|shell|exec|pty/.test(tool);
      const scroll = Math.floor(t * (term ? 8 : 4));
      for (let i = 0; i < Math.floor(sh / 2); i++) {
        const seed = (scroll + i) * 2654435761;
        const len = 2 + (Math.abs(seed) % Math.max(1, sw - 4));
        const indent = (Math.abs(seed >> 3) % 3) * 2;
        const col = term ? "#69db7c" : ["#74c0fc", "#ffd43b", "#b197fc", "#8ce99a"][Math.abs(seed >> 5) % 4];
        rect(g, sx + 1 + indent, sy + 1 + i * 2, Math.max(1, Math.min(len, sw - 2 - indent)), 1, col);
      }
      if (Math.floor(t * 3) % 2) rect(g, sx + sw - 2, sy + sh - 2, 1, 1, "#f8f9fa");
    } else if (st.status === "idle" || st.status === "done") {
      rect(g, sx + Math.floor(sw / 2) - 1, sy + Math.floor(sh / 2) - 1, 2, 2, "#2c3e66");
    }
  }

  private monitor(g: CanvasRenderingContext2D, s: Seat, st: SeatState | undefined, t: number) {
    const m = s.mon!;
    const x = Math.round(m.x - m.w / 2);
    const y = m.y - 9;
    rect(g, m.x - 2, m.y, 4, 3, "#343a40");
    rect(g, m.x - 4, m.y + 2, 8, 1, "#495057");
    rect(g, x, y, m.w, 10, "#212433");
    this.screen(g, x + 1, y + 1, m.w - 2, 8, st, t);
  }

  /** open laptop on the temps' table: lid (screen towards the sitter and us) + keyboard */
  private laptop(g: CanvasRenderingContext2D, s: Seat, st: SeatState | undefined, t: number) {
    const m = s.mon!;
    const x = Math.round(m.x - m.w / 2);
    const y = m.y;
    rect(g, x, y - 1, m.w, 8, "#adb5bd");
    rect(g, x, y - 1, m.w, 1, "#ced4da");
    this.screen(g, x + 1, y, m.w - 2, 6, st, t);
    rect(g, x - 1, y + 7, m.w + 2, 4, "#868e96");
    rect(g, x, y + 8, m.w, 2, "#495057");
    rect(g, m.x - 2, y + 10, 4, 1, "#adb5bd");
  }

  // ---------- lights (night mode) ----------

  lights(dyn: Dyn, t: number): Light[] {
    const out: Light[] = [...this.lightsStatic];
    for (const s of this.seats) {
      const st = dyn.seats.get(s.id);
      if (!s.mon || !st) continue;
      const busy = st.status === "busy" || st.status === "retry";
      const color = st.status === "error" ? "#ff6b6b" : st.waiting ? "#ffa94d" : st.browsing ? "#faa2c1" : "#74c0fc";
      out.push({ x: s.mon.x, y: s.mon.y + 2, r: busy || st.waiting || st.status === "error" ? 26 : 14, color, a: busy ? 0.55 : 0.3 });
    }
    for (const z of ZONES) out.push({ x: (z.x + z.w / 2) * T, y: (z.y + z.h / 2) * T, r: Math.max(z.w, z.h) * 7, color: "#ffe8b0", a: 0.22 });
    out.push({ x: this.hall.x * T + 8 * T, y: 10 * T, r: 60, color: "#ffe8b0", a: 0.18 });
    out.push({ x: 24 * T, y: 10 * T, r: 60, color: "#ffe8b0", a: 0.18 });
    out.push({ x: 16 * T, y: 17 * T, r: 50, color: "#ffe8b0", a: 0.18 });
    const b = this.ballAt;
    out.push({ x: b.x, y: b.y - 4, r: dyn.oracleBusy ? 40 + Math.sin(t * 5) * 4 : 20, color: "#b197fc", a: dyn.oracleBusy ? 0.6 : 0.35 });
    for (const c of this.candles) out.push({ x: c.x, y: c.y, r: 10, color: "#ffa94d", a: 0.4 });
    const tv = this.tvScreen;
    out.push({ x: tv.x + tv.w / 2, y: tv.y + tv.h, r: 46, color: "#74c0fc", a: dyn.tvWatchers ? 0.5 + Math.sin(t * 7) * 0.05 : 0.25 });
    out.push({ x: this.arcadeScreen.x + 4, y: this.arcadeScreen.y + 8, r: 20, color: "#e64980", a: 0.4 });
    out.push({ x: this.rackAt.x + 4, y: this.rackAt.y + 10, r: 16, color: "#69db7c", a: dyn.bash ? 0.45 : 0.2 });
    for (const tx of WINDOWS) out.push({ x: tx * T + 16, y: 34, r: 30, color: "#a5b4fc", a: 0.25 });
    return out;
  }
}
