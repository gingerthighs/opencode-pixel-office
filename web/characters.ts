// People (permanent staff + temps) and the office cat.
//
// A person bound to an agent session runs the paper workflow:
//   fetch (assignment from the boss's outbox) → toDesk → work → deliver (report into the inbox)
// Unbound staff fill their time with breaks: coffee, TV, beanbag, arcade, ping-pong, phone, web, cat.

import type { Agent } from "../src/types.ts";
import type { Office, Seat, Spot, SpotKind, Tile } from "./office.ts";
import type { Look, StaffDef } from "./roles.ts";
import { CHAR_FEET, catSprite, charSprite, rect, T, type CatPose, type Pose } from "./sprites.ts";

const SPEED = 46; // px per second
const BOSS_BREAK_AFTER = 6000; // ms the boss idles before leaving the desk

export type Phase = "idle" | "fetch" | "toDesk" | "work" | "deliver" | "leave";
export type Activity = "coffee" | "sofa" | "beanbag" | "arcade" | "pingpong" | "phone" | "pc" | "cat" | "wander";

export const ACTIVITY_LABEL: Record<Activity, string> = {
  coffee: "Kaffeepause",
  sofa: "schaut fern",
  beanbag: "chillt im Sitzsack",
  arcade: "zockt am Automaten",
  pingpong: "spielt Tischtennis",
  phone: "am Handy",
  pc: "surft im Netz",
  cat: "streichelt die Katze",
  wander: "vertritt sich die Beine",
};

const ACTIVITY_WEIGHTS: [Activity, number][] = [
  ["coffee", 14],
  ["sofa", 16],
  ["beanbag", 8],
  ["arcade", 7],
  ["pingpong", 9],
  ["phone", 16],
  ["pc", 14],
  ["cat", 8],
  ["wander", 6],
];

const SPOT_OF: Partial<Record<Activity, SpotKind>> = { coffee: "coffee", sofa: "sofa", beanbag: "beanbag", arcade: "arcade", pingpong: "pingpong" };

/** What a person needs from the scene each frame. */
export interface World {
  office: Office;
  now: number;
  cat: { x: number; y: number };
  onPickup(p: Person): void;
  onTaskOnDesk(p: Person): void;
  onLeaveDesk(p: Person): void;
  onDeliver(p: Person): void;
}

type Pt = { x: number; y: number };

const tileOf = (p: Pt): Tile => ({ tx: Math.floor(p.x / T), ty: Math.floor(p.y / T) });
const center = (t: Tile): Pt => ({ x: t.tx * T + 8, y: t.ty * T + 12 });

function pickWeighted<A>(items: [A, number][]): A {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [a, w] of items) if ((r -= w) <= 0) return a;
  return items[0][0];
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export interface PersonInit {
  id: string;
  name: string;
  team: string;
  look: Look;
  staff?: StaffDef;
  home?: Seat;
  isBoss?: boolean;
  temp?: boolean;
}

export class Person {
  readonly id: string;
  readonly staff?: StaffDef;
  readonly isBoss: boolean;
  readonly temp: boolean;
  name: string;
  team: string;
  look: Look;
  home?: Seat;
  agentId?: string;
  phase: Phase = "idle";
  activity?: Activity;
  spot?: Spot;
  carrying?: "task" | "report";
  x = 0;
  y = 0;
  dir: Pose = "down";
  alpha = 1;
  gone = false;
  /** finished assignments since the view opened */
  done = 0;
  private path: Pt[] = [];
  private walkT = 0;
  private anim = Math.random() * 10;
  private seatedAt?: "desk" | "spot";
  private sitOnArrive?: "desk" | "spot";
  private faceOnArrive?: Pose;
  private arrive?: () => void;
  private pending?: () => void;
  private waitUntil = 0;
  private activityUntil = 0;
  private idleSince = 0;

  constructor(init: PersonInit) {
    this.id = init.id;
    this.name = init.name;
    this.team = init.team;
    this.look = init.look;
    this.staff = init.staff;
    this.home = init.home;
    this.isBoss = !!init.isBoss;
    this.temp = !!init.temp;
  }

  get walking() {
    return this.path.length > 0;
  }

  get sitting() {
    return !!this.seatedAt && !this.walking;
  }

  get atDesk() {
    return this.seatedAt === "desk" && !this.walking;
  }

  get browsing() {
    return this.atDesk && !this.agentId && this.activity === "pc";
  }

  get headY() {
    return this.y - CHAR_FEET + (this.sitting ? 3 : 0) + 2;
  }

  /** what to show when hovering an off-duty person */
  get statusText(): string {
    if (this.phase === "fetch") return "holt einen Auftrag";
    if (this.phase === "toDesk") return "geht an den Schreibtisch";
    if (this.phase === "deliver") return "bringt den Bericht zum Chef";
    if (this.phase === "leave") return "geht nach Hause";
    return this.activity ? ACTIVITY_LABEL[this.activity] : "Pause";
  }

  // ---------- placement & movement ----------

  /** put the person somewhere instantly (view (re)build) */
  place(pt: Pt, dir: Pose, seated?: "desk" | "spot") {
    this.x = pt.x;
    this.y = pt.y;
    this.dir = dir;
    this.seatedAt = seated;
    this.path = [];
  }

  /** spawn at the door (temps) */
  enterAt(office: Office) {
    this.place(center(office.door), "up");
  }

  /** start a placed person in their current state without walking there */
  settle(world: World) {
    if (this.agentId) {
      if (this.home) this.place({ x: this.home.px, y: this.home.py }, "up", "desk");
      this.phase = this.isBoss ? "idle" : "work";
      if (!this.isBoss) world.onTaskOnDesk(this);
      return;
    }
    this.startActivity(world, true);
  }

  private moveTo(office: Office, target: Tile, final: Pt, face?: Pose, sit?: "desk" | "spot", then?: () => void) {
    // getting up from a sofa/beanbag: step off forward first instead of climbing over it
    const fromSpot = this.seatedAt === "spot" && this.spot?.via;
    const from: Tile = fromSpot ? this.spot!.via! : tileOf(this);
    const lead = fromSpot ? [center(this.spot!.via!)] : [];
    this.seatedAt = undefined;
    this.path = [...lead, ...office.path(from, target).map(center), final];
    this.faceOnArrive = face;
    this.sitOnArrive = sit;
    this.arrive = then;
  }

  private walk(dt: number) {
    let budget = SPEED * dt;
    this.walkT += dt;
    while (budget > 0 && this.path.length) {
      const p = this.path[0];
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? "right" : "left";
        else this.dir = dy > 0 ? "down" : "up";
      }
      if (dist <= budget) {
        this.x = p.x;
        this.y = p.y;
        budget -= dist;
        this.path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  }

  // ---------- binding ----------

  bind(agentId: string, office: Office) {
    this.agentId = agentId;
    this.activity = undefined;
    office.releaseSpot(this.id);
    this.phase = this.isBoss ? "idle" : "fetch";
    this.idleSince = performance.now();
    // finish the current step, then re-plan from there
    if (this.path.length) {
      this.path = this.path.slice(0, 1);
      this.sitOnArrive = undefined;
      this.faceOnArrive = undefined;
    }
    this.arrive = undefined;
    this.pending = undefined;
    this.waitUntil = 0;
  }

  // ---------- per-frame ----------

  update(dt: number, agent: Agent | undefined, w: World) {
    if (this.gone) return;
    if (this.walking) {
      this.walk(dt);
      if (!this.walking) {
        this.seatedAt = this.sitOnArrive;
        if (this.faceOnArrive) this.dir = this.faceOnArrive;
        const cb = this.arrive;
        this.arrive = undefined;
        cb?.();
      }
      return;
    }
    if (this.phase === "leave") {
      this.alpha -= dt * 2.5;
      if (this.alpha <= 0) {
        this.gone = true;
        w.office.releaseSeat(this.id);
        w.office.releaseSpot(this.id);
      }
      return;
    }
    if (w.now < this.waitUntil) return;
    if (this.pending) {
      const f = this.pending;
      this.pending = undefined;
      f();
      return;
    }
    this.think(agent, w);
  }

  private think(agent: Agent | undefined, w: World) {
    if (!this.agentId) return this.idleRoutine(w);
    const done = !agent || agent.status === "done";

    if (this.isBoss) {
      const active = !!agent && (agent.status === "busy" || agent.status === "retry" || agent.waiting || agent.status === "error");
      if (active || w.now - this.idleSince < BOSS_BREAK_AFTER) {
        if (active) {
          this.idleSince = w.now;
          this.activity = undefined;
        }
        if (!this.atDesk) this.goDesk(w);
        return;
      }
      return this.idleRoutine(w);
    }

    switch (this.phase) {
      case "idle":
      case "fetch":
        this.phase = "fetch";
        return this.goPickup(w);
      case "toDesk":
        return this.goDesk(w);
      case "work":
        if (done) {
          this.phase = "deliver";
          this.carrying = "report";
          w.onLeaveDesk(this);
          return this.goDrop(w);
        }
        if (!this.atDesk && this.home) this.goDesk(w);
        return;
      case "deliver":
        return this.goDrop(w);
    }
  }

  private goPickup(w: World) {
    const slot = w.office.pickup[Math.abs(hashStr(this.id)) % w.office.pickup.length];
    this.moveTo(w.office, slot, center(slot), slot.face, undefined, () => {
      this.waitUntil = w.now + 700;
      this.pending = () => {
        this.carrying = "task";
        w.onPickup(this);
        this.phase = "toDesk";
      };
    });
  }

  private goDesk(w: World) {
    w.office.releaseSpot(this.id);
    const seat = this.home;
    if (!seat) {
      // no free desk: work standing in the open-plan area
      const t = w.office.randomFreeTileIn({ x: 10, y: 10, w: 11, h: 4 });
      this.moveTo(w.office, t, center(t), "down", undefined, () => this.arrivedAtDesk(w));
      return;
    }
    this.moveTo(w.office, seat, { x: seat.px, y: seat.py }, "up", "desk", () => this.arrivedAtDesk(w));
  }

  private arrivedAtDesk(w: World) {
    if (this.phase === "toDesk") {
      this.phase = "work";
      this.carrying = undefined;
      w.onTaskOnDesk(this);
    }
  }

  private goDrop(w: World) {
    const slot = w.office.dropoff[Math.abs(hashStr(this.id)) % w.office.dropoff.length];
    this.moveTo(w.office, slot, center(slot), slot.face, undefined, () => {
      this.waitUntil = w.now + 600;
      this.pending = () => {
        this.carrying = undefined;
        this.done++;
        w.onDeliver(this);
        this.agentId = undefined;
        if (this.temp) {
          this.phase = "leave";
          this.moveTo(w.office, w.office.door, { x: w.office.door.tx * T + 8, y: w.office.door.ty * T + 14 }, "down");
        } else {
          this.phase = "idle";
          this.activityUntil = 0;
        }
      };
    });
  }

  // ---------- off duty ----------

  private idleRoutine(w: World) {
    if (this.activity && w.now < this.activityUntil) return;
    this.startActivity(w, false);
  }

  private startActivity(w: World, instant: boolean) {
    const office = w.office;
    for (let attempt = 0; attempt < 6; attempt++) {
      const act = pickWeighted(ACTIVITY_WEIGHTS);
      if (act === this.activity && attempt < 5) continue;
      if (this.tryActivity(act, w, instant)) {
        this.activity = act;
        const span = act === "pingpong" ? [25, 45] : act === "sofa" ? [30, 60] : [15, 35];
        this.activityUntil = w.now + (span[0] + Math.random() * (span[1] - span[0])) * 1000 + (instant ? 0 : 8000);
        return;
      }
    }
    // nothing worked: stand around with the phone
    const t = office.randomFreeTileIn(office.lounge);
    this.go(w, t, center(t), "down", undefined, instant);
    this.activity = "phone";
    this.activityUntil = w.now + 15000;
  }

  private go(w: World, tile: Tile, final: Pt, face: Pose, sit: "desk" | "spot" | undefined, instant: boolean) {
    if (instant) this.place(final, face, sit);
    else this.moveTo(w.office, tile, final, face, sit);
  }

  private tryActivity(act: Activity, w: World, instant: boolean): boolean {
    const office = w.office;
    const kind = SPOT_OF[act];
    if (kind) {
      const prev = this.spot;
      const spot = office.claimSpotKind(kind, this.id);
      if (!spot) {
        this.spot = prev;
        return false;
      }
      // remember where we sat so moveTo can step off it, then switch
      const leaving = this.spot;
      this.go(w, spot.via ?? spot, { x: spot.px, y: spot.py }, spot.face, spot.sit ? "spot" : undefined, instant);
      void leaving;
      this.spot = spot;
      return true;
    }
    switch (act) {
      case "pc": {
        if (!this.home) return false;
        office.releaseSpot(this.id);
        this.go(w, this.home, { x: this.home.px, y: this.home.py }, "up", "desk", instant);
        this.spot = undefined;
        return true;
      }
      case "phone": {
        office.releaseSpot(this.id);
        const t = office.randomFreeTileIn(Math.random() < 0.6 ? office.lounge : { x: 10, y: 8, w: 11, h: 6 });
        this.go(w, t, center(t), "down", undefined, instant);
        this.spot = undefined;
        return true;
      }
      case "cat": {
        if (instant) return false;
        const c = tileOf(w.cat);
        const options: [Tile, Pose][] = [
          [{ tx: c.tx - 1, ty: c.ty }, "right"],
          [{ tx: c.tx + 1, ty: c.ty }, "left"],
          [{ tx: c.tx, ty: c.ty + 1 }, "up"],
          [{ tx: c.tx, ty: c.ty - 1 }, "down"],
        ];
        const free = options.find(([t]) => !office.isBlocked(t.tx, t.ty));
        if (!free) return false;
        office.releaseSpot(this.id);
        this.moveTo(office, free[0], center(free[0]), free[1]);
        this.spot = undefined;
        return true;
      }
      default: {
        office.releaseSpot(this.id);
        const t = office.randomFreeTile();
        this.go(w, t, center(t), (["down", "left", "right"] as Pose[])[Math.floor(Math.random() * 3)], undefined, instant);
        this.spot = undefined;
        return true;
      }
    }
  }

  // ---------- drawing ----------

  draw(g: CanvasRenderingContext2D, t: number, agent: Agent | undefined, office: Office, selected: boolean) {
    const walking = this.walking;
    const busy = !!this.agentId && (agent?.status === "busy" || agent?.status === "retry");
    const act = this.agentId ? undefined : this.activity;
    let sprite: HTMLCanvasElement;
    let dy = 0;
    if (this.sitting) {
      // sitting is always seen from behind (desk, sofa and beanbags face up)
      const typing = this.seatedAt === "desk" && (busy || (this.browsing && Math.floor(t * 0.7) % 3 === 0));
      sprite = charSprite(this.look, "up", typing ? Math.floor(t * 7) % 2 : 0, true);
      dy = 3;
    } else {
      const cycle = [1, 0, 2, 0];
      const frame = walking ? cycle[Math.floor(this.walkT * 8) % 4] : 0;
      sprite = charSprite(this.look, this.dir, frame, false);
      if (!walking) dy = Math.floor(t * 1.2 + this.anim) % 2;
      else dy = frame === 0 ? 0 : -1;
    }
    const x = Math.round(this.x) - 8;
    const y = Math.round(this.y) - CHAR_FEET + dy;
    const alpha = Math.max(0, this.alpha);
    g.globalAlpha = alpha;
    if (!this.sitting) {
      g.globalAlpha = alpha * 0.35;
      rect(g, x + 4, Math.round(this.y), 8, 2, "#000");
      rect(g, x + 3, Math.round(this.y) + 1, 10, 1, "#000");
      g.globalAlpha = alpha;
    }
    if (selected) {
      const pulse = Math.floor(t * 4) % 2;
      rect(g, x + 2 - pulse, Math.round(this.y) + 2, 12 + pulse * 2, 1, "#ffd43b");
    }
    // paper carried behind the body when walking away from us
    if (this.carrying && this.dir === "up" && !this.sitting) this.paper(g, x + 10, y + 11);
    g.drawImage(sprite, x, y);
    if (this.carrying && this.dir !== "up" && !this.sitting) {
      const px = this.dir === "left" ? x + 2 : this.dir === "right" ? x + 9 : x + 5;
      this.paper(g, px, y + 13);
    }
    // blink when facing us
    if (!this.sitting && this.dir === "down" && !walking && (t + this.anim * 3) % 4.2 < 0.13) {
      rect(g, x + 6, y + 9, 1, 2, this.look.skin);
      rect(g, x + 9, y + 9, 1, 2, this.look.skin);
      rect(g, x + 6, y + 10, 1, 1, "#1d1a2b");
      rect(g, x + 9, y + 10, 1, 1, "#1d1a2b");
    }
    if (!walking && !this.sitting) {
      if (act === "phone") {
        rect(g, x + 7, y + 14, 3, 4, "#212529");
        rect(g, x + 8, y + 15, 1, 2, Math.floor(t * 2) % 2 ? "#74c0fc" : "#a5d8ff");
      } else if (act === "pingpong") {
        const swing = Math.floor(t * 3 + this.anim) % 2;
        const px = this.dir === "right" ? x + 13 : x - 1;
        rect(g, px, y + 12 - swing, 3, 3, "#e03131");
        rect(g, px + 1, y + 15 - swing, 1, 2, "#8d5524");
      } else if (act === "coffee") {
        rect(g, x + 11, y + 15, 3, 3, "#f8f9fa");
        rect(g, x + 12, y + 15, 1, 1, "#8d5524");
      } else if (act === "cat" && (t + this.anim) % 2 < 1.2) {
        const k = (t * 0.8 + this.anim) % 1;
        const hy = y - Math.round(k * 6);
        g.globalAlpha = alpha * (1 - k);
        rect(g, x + 7, hy - 2, 1, 1, "#ff6b6b");
        rect(g, x + 9, hy - 2, 1, 1, "#ff6b6b");
        rect(g, x + 7, hy - 1, 3, 1, "#ff6b6b");
        rect(g, x + 8, hy, 1, 1, "#ff6b6b");
        g.globalAlpha = alpha;
      }
    }
    if (this.seatedAt === "desk" && this.home && this.sitting) office.chairBack(g, this.home.px, this.home.py);
    if (agent?.status === "retry" && this.agentId) rect(g, x + 13, y + 5 + (Math.floor(t * 3) % 2), 2, 3, "#74c0fc");
    g.globalAlpha = 1;
  }

  private paper(g: CanvasRenderingContext2D, x: number, y: number) {
    const report = this.carrying === "report";
    rect(g, x - 1, y - 1, 7, 6, "#16121f");
    rect(g, x, y, 5, 4, report ? "#ffffff" : "#fff3bf");
    rect(g, x + 1, y + 1, 3, 1, report ? "#40c057" : "#e03131");
  }

  hit(wx: number, wy: number) {
    return wx >= this.x - 7 && wx <= this.x + 7 && wy >= this.y - CHAR_FEET + 3 && wy <= this.y + 2;
  }
}

// ---------- the office cat ----------

type CatPlan = "wander" | "eat" | "tree" | "bed" | "visit" | "sit";

/** Lives in the cat corner: eats, climbs its tree, naps in its bed, and visits people. */
export class Cat {
  x: number;
  y: number;
  private flip = false;
  private path: Pt[] = [];
  private plan: CatPlan = "bed";
  private until = 0;
  private walkT = 0;
  private perch?: Spot;

  constructor(office: Office) {
    const bed = office.spots.find((s) => s.kind === "cat-bed");
    this.x = bed ? bed.px : 4 * T + 8;
    this.y = bed ? bed.py : 22 * T + 10;
    this.until = performance.now() + 8000;
  }

  get pose(): CatPose {
    if (this.path.length) return Math.floor(this.walkT * 6) % 2 ? "walk1" : "walk0";
    return this.plan === "bed" ? "sleep" : "sit";
  }

  update(dt: number, office: Office, now: number, people: { x: number; y: number }[]) {
    if (this.path.length) {
      this.walkT += dt;
      let budget = (this.plan === "visit" ? 26 : 20) * dt;
      while (budget > 0 && this.path.length) {
        const p = this.path[0];
        const dx = p.x - this.x;
        const dy = p.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.1) this.flip = dx > 0;
        if (dist <= budget) {
          this.x = p.x;
          this.y = p.y;
          budget -= dist;
          this.path.shift();
        } else {
          this.x += (dx / dist) * budget;
          this.y += (dy / dist) * budget;
          budget = 0;
        }
      }
      if (!this.path.length) {
        const stay = { wander: 5000, eat: 7000, tree: 14000, bed: 25000, visit: 9000, sit: 6000 }[this.plan];
        this.until = now + stay * (0.7 + Math.random() * 0.6);
        if (this.plan === "eat") this.flip = true;
      }
      return;
    }
    if (now < this.until) return;

    const from: Tile = this.perch?.via ?? tileOf(this);
    const lead = this.perch?.via ? [center(this.perch.via)] : [];
    this.perch = undefined;
    this.plan = pickWeighted<CatPlan>([
      ["wander", 3],
      ["eat", 2],
      ["tree", 2],
      ["bed", 3],
      ["visit", people.length ? 2 : 0],
      ["sit", 1],
    ]);
    let target: Tile;
    let final: Pt | undefined;
    const spotKind: Partial<Record<CatPlan, SpotKind>> = { eat: "cat-food", tree: "cat-tree", bed: "cat-bed" };
    const kind = spotKind[this.plan];
    if (kind) {
      const s = office.spots.find((x) => x.kind === kind)!;
      this.perch = s.via ? s : undefined;
      target = s.via ?? s;
      final = { x: s.px, y: s.py };
    } else if (this.plan === "visit") {
      const p = people[Math.floor(Math.random() * people.length)];
      const t = tileOf(p);
      const near = [
        { tx: t.tx + 1, ty: t.ty },
        { tx: t.tx - 1, ty: t.ty },
        { tx: t.tx, ty: t.ty + 1 },
      ].find((n) => !office.isBlocked(n.tx, n.ty));
      target = near ?? office.randomFreeTile();
    } else {
      target = this.plan === "sit" ? office.randomFreeTileIn({ x: 1, y: 19, w: 6, h: 4 }) : office.randomFreeTile();
    }
    this.path = [...lead, ...office.path(from, target).map(center)];
    if (final) this.path.push(final);
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const pose = this.pose;
    const x = Math.round(this.x) - 7;
    const y = Math.round(this.y) - 10;
    g.globalAlpha = 0.3;
    rect(g, x + 3, Math.round(this.y), 8, 1, "#000");
    g.globalAlpha = 1;
    g.drawImage(catSprite(pose, this.flip), x, y);
    if (pose === "sleep") {
      const k = (t * 0.5) % 1;
      g.globalAlpha = 1 - k;
      rect(g, x + 11 + Math.round(k * 3), y - 1 - Math.round(k * 5), 2, 1, "#e9ecef");
      rect(g, x + 12 + Math.round(k * 3), y - Math.round(k * 5), 1, 1, "#e9ecef");
      g.globalAlpha = 1;
    }
    if (this.plan === "eat" && !this.path.length && Math.floor(t * 4) % 2) rect(g, x + 13, y + 9, 1, 1, "#8d5524");
  }
}
