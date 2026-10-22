// Procedural pixel sprites, drawn once into small cached canvases.

import type { Look } from "./roles.ts";

export const T = 16;
export const OUTLINE = "#16121f";

export type Pose = "down" | "up" | "left" | "right";
type Ctx = CanvasRenderingContext2D;

const cache = new Map<string, HTMLCanvasElement>();

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb color. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const out = amt < 0 ? v * (1 + amt) : v + (255 - v) * amt;
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function outline(c: HTMLCanvasElement, color = OUTLINE) {
  const ctx = c.getContext("2d")!;
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0;
  ctx.fillStyle = color;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function mirror(src: HTMLCanvasElement): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(src.width, src.height);
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

// ---------- characters ----------

/** Character canvas is 16×21; feet touch row 19. Rows 0–4 are headroom for hats. */
export const CHAR_W = 16;
export const CHAR_H = 21;
export const CHAR_FEET = 19;

export function charSprite(look: Look, pose: Pose, frame: number, sitting = false): HTMLCanvasElement {
  const key = `c|${look.skin}|${look.hair}|${look.shirt}|${look.acc}|${look.accColor}|${pose}|${frame}|${sitting}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (pose === "right") {
    const c = mirror(charSprite(look, "left", frame, sitting));
    cache.set(key, c);
    return c;
  }
  const [c, ctx] = makeCanvas(CHAR_W, CHAR_H);
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(ctx, x, y, w, h, col);
  const B = 5;
  const { skin, hair, shirt, pants } = look;
  const shirtD = shade(shirt, -0.28);
  const pantsD = shade(pants, -0.3);
  const shoe = "#241d2e";
  const eye = "#1d1a2b";

  // legs
  if (!sitting) {
    if (pose === "left") {
      if (frame === 1) {
        r(5, B + 11, 2, 3, pants);
        r(9, B + 11, 2, 3, pantsD);
        r(4, B + 14, 3, 1, shoe);
        r(9, B + 14, 3, 1, shoe);
      } else if (frame === 2) {
        r(6, B + 11, 2, 3, pantsD);
        r(8, B + 11, 2, 3, pants);
        r(5, B + 14, 3, 1, shoe);
        r(8, B + 14, 3, 1, shoe);
      } else {
        r(6, B + 11, 4, 3, pants);
        r(5, B + 14, 5, 1, shoe);
      }
    } else {
      const l = frame === 1 ? 1 : 0;
      const rr = frame === 2 ? 1 : 0;
      r(5, B + 11, 2, 3 - l, pants);
      r(9, B + 11, 2, 3 - rr, pants);
      r(5, B + 14 - l, 2, 1, shoe);
      r(9, B + 14 - rr, 2, 1, shoe);
    }
  }

  // torso + arms
  if (pose === "left") {
    r(5, B + 7, 6, 4, shirt);
    r(5, B + 10, 6, 1, shirtD);
    const ax = frame === 1 ? -1 : frame === 2 ? 1 : 0;
    r(7 + ax, B + 7, 2, 3, shirtD);
    r(7 + ax, B + 10, 2, 1, skin);
  } else {
    r(4, B + 7, 8, 4, shirt);
    r(4, B + 10, 8, 1, shirtD);
    if (sitting) {
      const k = frame % 2;
      r(3, B + 7 + k, 1, 2, shirtD);
      r(12, B + 8 - k, 1, 2, shirtD);
    } else {
      const s = frame === 1 ? 1 : frame === 2 ? -1 : 0;
      r(3, B + 7 + Math.max(0, s), 1, 3, shirtD);
      r(12, B + 7 + Math.max(0, -s), 1, 3, shirtD);
      r(3, B + 10 + Math.max(0, s), 1, 1, skin);
      r(12, B + 10 + Math.max(0, -s), 1, 1, skin);
    }
    if (look.acc === "crown" && pose === "down") r(7, B + 7, 2, 3, "#c92a2a"); // boss tie
  }

  // head
  if (pose === "up") {
    r(4, B, 8, 7, hair);
    r(5, B + 6, 6, 1, shade(hair, -0.25));
  } else if (pose === "left") {
    r(4, B, 8, 7, skin);
    r(4, B, 8, 3, hair);
    r(8, B + 3, 4, 3, hair);
    r(5, B + 4, 1, 2, eye);
  } else {
    r(4, B, 8, 7, skin);
    r(4, B, 8, 3, hair);
    r(4, B + 3, 1, 2, hair);
    r(11, B + 3, 1, 2, hair);
    r(6, B + 4, 1, 2, eye);
    r(9, B + 4, 1, 2, eye);
    r(5, B + 6, 1, 1, shade(skin, -0.12));
    r(10, B + 6, 1, 1, shade(skin, -0.12));
  }

  accessory(r, look, pose, B);
  outline(c);
  cache.set(key, c);
  return c;
}

function accessory(r: (x: number, y: number, w: number, h: number, c: string) => void, look: Look, pose: Pose, B: number) {
  const col = look.accColor;
  const dark = shade(col, -0.3);
  const side = pose === "left";
  switch (look.acc) {
    case "crown":
      r(5, B - 2, 6, 2, col);
      r(5, B - 3, 1, 1, col);
      r(7, B - 3, 2, 1, col);
      r(10, B - 3, 1, 1, col);
      r(7, B - 2, 2, 1, "#e03131");
      break;
    case "cap":
      r(4, B - 1, 8, 3, col);
      r(6, B - 2, 4, 1, col);
      if (pose === "down") r(4, B + 2, 8, 1, dark);
      if (side) r(2, B + 1, 3, 1, dark);
      break;
    case "hardhat":
      r(4, B - 1, 8, 3, col);
      r(5, B - 2, 6, 1, col);
      r(7, B - 2, 2, 3, shade(col, 0.35));
      if (pose !== "up") r(3, B + 2, 10, 1, dark);
      break;
    case "beret":
      r(4, B - 1, 7, 2, col);
      r(5, B - 2, 5, 1, col);
      r(10, B - 3, 1, 2, dark);
      break;
    case "wizard":
      r(3, B + 1, 10, 1, dark);
      r(4, B - 1, 8, 2, col);
      r(5, B - 3, 6, 2, col);
      r(6, B - 4, 4, 1, col);
      r(7, B - 5, 2, 1, col);
      r(7, B - 2, 1, 1, "#ffd43b");
      break;
    case "glasses":
      if (pose === "down") {
        r(5, B + 4, 3, 2, col);
        r(8, B + 4, 3, 2, col);
        r(6, B + 4, 1, 1, "#a5d8ff");
        r(9, B + 4, 1, 1, "#a5d8ff");
      } else if (side) {
        r(4, B + 4, 3, 2, col);
        r(5, B + 4, 1, 1, "#a5d8ff");
      }
      break;
    case "visor":
      if (pose !== "up") {
        r(4, B + 2, 8, 1, col);
        r(side ? 2 : 4, B + 3, side ? 5 : 8, 1, dark);
      } else {
        r(4, B + 2, 8, 1, col);
      }
      break;
    case "headset":
      r(3, B + 2, 1, 4, col);
      r(12, B + 2, 1, 4, col);
      r(4, B - 1, 8, 1, col);
      if (pose === "down") r(4, B + 6, 3, 1, col);
      break;
  }
}

// ---------- icons (8×8) ----------

const ICON_PALETTE: Record<string, string> = {
  "#": OUTLINE,
  w: "#f8f9fa",
  k: "#868e96",
  d: "#495057",
  b: "#4dabf7",
  g: "#51cf66",
  y: "#fcc419",
  o: "#ff922b",
  r: "#ff6b6b",
  p: "#b197fc",
};

const ICONS: Record<string, string[]> = {
  page: ["#####...", "#www##..", "#wwww##.", "#wkkkw#.", "#wwwww#.", "#wkkkw#.", "#wwwww#.", "#######."],
  pencil: ["......##", ".....#r#", "....#oo#", "...#oo#.", "..#oo#..", ".#yy#...", "#dd#....", "##......"],
  terminal: ["########", "#dddddd#", "#dgdddd#", "#ddgddd#", "#dgdddd#", "#dddggd#", "#dddddd#", "########"],
  magnifier: [".####...", "#bbbb#..", "#bwbb#..", "#bbbb#..", ".####...", "....##..", ".....##.", "......##"],
  globe: ["..####..", ".#bgbb#.", "#bggbbb#", "#bbggbg#", "#bbbggg#", "#gbbbgb#", ".#bbbb#.", "..####.."],
  plane: ["......##", "....##w#", "..##ww#.", "##www#..", "..#kw#..", "...#w#..", "....##..", "........"],
  clipboard: [".##kk##.", "#owkkwo#", "#owwwwo#", "#ogwkko#", "#owwwwo#", "#ogwkko#", "#owwwwo#", "########"],
  gear: ["...##...", ".#.##.#.", "..#kk#..", "##kwwk##", "##kwwk##", "..#kk#..", ".#.##.#.", "...##..."],
  question: ["..####..", ".#yyyy#.", ".#y##y#.", "....#y#.", "...#y#..", "...#y#..", "........", "...#y#.."],
  alert: ["...##...", "..#rr#..", "..#rr#..", "..#rr#..", "..#rr#..", "...##...", "..#rr#..", "...##..."],
  think: ["........", ".######.", "#wwwwww#", "#wpwpwp#", "#wwwwww#", ".######.", "..##....", ".#......"],
  speech: [".######.", "#wwwwww#", "#wkkkkw#", "#wwwwww#", "#wkkkww#", ".#####..", ".##.....", "#......."],
  check: [".......#", "......#g", ".....#g#", "#...#g#.", "g#.#g#..", ".g#g#...", "..gg#...", "...#...."],
  zzz: ["........", "..####..", ".....#..", "....#...", "...#....", "..####..", "........", "........"],
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLCanvasElement {
  const key = "i|" + name;
  const hit = cache.get(key);
  if (hit) return hit;
  const [c, ctx] = makeCanvas(8, 8);
  ICONS[name].forEach((row, y) => {
    for (let x = 0; x < 8; x++) {
      const col = ICON_PALETTE[row[x]];
      if (col) rect(ctx, x, y, 1, 1, col);
    }
  });
  cache.set(key, c);
  return c;
}

export function toolIcon(tool: string): IconName {
  const n = tool.toLowerCase();
  if (/todo/.test(n)) return "clipboard";
  if (/(task|delegate|background|call_omo|agent|spawn)/.test(n)) return "plane";
  if (/(web|fetch|url|context7|exa|http|browser|search_docs)/.test(n)) return "globe";
  if (/(edit|write|patch|apply)/.test(n)) return "pencil";
  if (/(bash|shell|exec|terminal|interactive|pty)/.test(n)) return "terminal";
  if (/(grep|glob|search|find|list|^ls$|ast)/.test(n)) return "magnifier";
  if (/(read|view|look|lsp)/.test(n)) return "page";
  if (/(question|ask)/.test(n)) return "question";
  return "gear";
}

export function paperPlane(): HTMLCanvasElement {
  const key = "plane";
  const hit = cache.get(key);
  if (hit) return hit;
  const [c, ctx] = makeCanvas(9, 7);
  const rows = ["......##.", "....##w#.", "..##ww#..", "##www#...", "..#kw#...", "...#w#...", "....#...."];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = ICON_PALETTE[row[x]];
      if (col) rect(ctx, x, y, 1, 1, col);
    }
  });
  cache.set(key, c);
  return c;
}
