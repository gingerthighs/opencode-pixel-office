// One walking/sitting pixel person per agent.

import type { Agent } from "../src/types.ts";
import type { Office, Seat, Spot, Tile } from "./office.ts";
import { lookOf, roleOf, type Look } from "./roles.ts";
import { CHAR_FEET, catSprite, charSprite, rect, T, type CatPose, type Pose } from "./sprites.ts";

const SPEED = 46; // px per second
const IDLE_TO_LOUNGE = 6; // seconds a root agent idles before strolling to the lounge

type Goal = "seat" | "lounge" | "door";

export class Char {
  readonly id: string;
  x: number;
  y: number;
  dir: Pose = "up";
  look: Look;
  name: string;
  seat?: Seat;
  spot?: Spot;
  goal: Goal | null = null;
  arrived = false;
  alpha = 1;
  gone = false;
  private path: { x: number; y: number }[] = [];
  private walkT = 0;
  /** per-character animation offset so not everyone breathes/blinks in sync */
  private phase = Math.random() * 10;
  private idleSince = 0;
  private lastStatus = "";

  constructor(agent: Agent, office: Office, spawnAtDoor: boolean, now: number) {
    this.id = agent.id;
    this.name = agent.name;
    this.look = lookOf(agent.name, agent.id);
    this.seat = office.claimSeat(roleOf(agent.name).zone, agent.id);
    this.idleSince = now;
    if (spawnAtDoor || !this.seat) {
      this.x = office.door.tx * T + 8;
      this.y = office.door.ty * T + 12;
    } else {
      this.x = this.seat.px;
      this.y = this.seat.py;
      this.goal = "seat";
      this.arrived = true;
    }
  }

  get sitting() {
    return this.arrived && ((this.goal === "seat" && !!this.seat) || (this.goal === "lounge" && !!this.spot?.sit));
  }

  get tile(): Tile {
    return { tx: Math.floor(this.x / T), ty: Math.floor(this.y / T) };
  }

  /** Head position in world px (for bubbles and name tags). */
  get headY() {
    return this.y - CHAR_FEET + (this.sitting ? 3 : 0) + 2;
  }

  update(dt: number, agent: Agent | undefined, office: Office, now: number) {
    if (agent && agent.name !== this.name) {
      // name resolved late (e.g. "subagent" → "explorer"): re-dress and move desks
      this.name = agent.name;
      this.look = lookOf(agent.name, agent.id);
      const zone = roleOf(agent.name).zone;
      if (this.seat?.zone !== zone) {
        office.releaseSeat(this.id);
        this.seat = office.claimSeat(zone, this.id);
        if (this.goal === "seat") this.goal = null;
      }
    }

    const status = agent ? (agent.waiting ? "waiting" : agent.status) : "gone";
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.idleSince = now;
    }

    let want: Goal = "seat";
    if (!agent || agent.status === "done") want = "door";
    else if (!agent.parentId && agent.status === "idle" && !agent.waiting && now - this.idleSince > IDLE_TO_LOUNGE * 1000) want = "lounge";
    if (want === "seat" && !this.seat) want = "lounge";

    if (want !== this.goal) this.setGoal(want, office);

    if (this.path.length) {
      this.walk(dt);
    } else if (!this.arrived) {
      this.arrived = true;
      if (this.goal === "seat") this.dir = "up";
      if (this.goal === "lounge" && this.spot) this.dir = this.spot.face;
    }

    if (this.goal === "door" && this.arrived) {
      this.alpha -= dt * 2.5;
      if (this.alpha <= 0) {
        this.gone = true;
        office.releaseSeat(this.id);
        office.releaseSpot(this.id);
      }
    }
  }

  private setGoal(goal: Goal, office: Office) {
    this.goal = goal;
    this.arrived = false;
    let target: Tile;
    let final: { x: number; y: number };
    if (goal === "seat" && this.seat) {
      office.releaseSpot(this.id);
      this.spot = undefined;
      target = this.seat;
      final = { x: this.seat.px, y: this.seat.py };
    } else if (goal === "lounge") {
      this.spot = office.claimSpot(this.id);
      if (!this.spot) {
        this.path = [];
        return;
      }
      target = this.spot;
      final = { x: this.spot.px, y: this.spot.py };
    } else {
      office.releaseSpot(this.id);
      target = office.door;
      final = { x: office.door.tx * T + 8, y: office.door.ty * T + 14 };
    }
    this.path = office.path(this.tile, target).map((t) => ({ x: t.tx * T + 8, y: t.ty * T + 12 }));
    this.path.push(final);
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

  draw(g: CanvasRenderingContext2D, t: number, agent: Agent | undefined, office: Office, selected: boolean) {
    const walking = this.path.length > 0;
    const busy = agent?.status === "busy" || agent?.status === "retry";
    let sprite: HTMLCanvasElement;
    let dy = 0;
    if (this.sitting && this.goal === "seat") {
      sprite = charSprite(this.look, "up", busy ? Math.floor(t * 7) % 2 : 0, true);
      dy = 3;
    } else if (this.sitting) {
      sprite = charSprite(this.look, "down", 0, false);
      dy = -1;
    } else {
      const cycle = [1, 0, 2, 0];
      const frame = walking ? cycle[Math.floor(this.walkT * 8) % 4] : 0;
      sprite = charSprite(this.look, this.dir, frame, false);
      // breathing while standing, a step bounce while walking
      if (!walking) dy = Math.floor(t * 1.2 + this.phase) % 2;
      else dy = frame === 0 ? 0 : -1;
    }
    const x = Math.round(this.x) - 8;
    const y = Math.round(this.y) - CHAR_FEET + dy;
    g.globalAlpha = Math.max(0, this.alpha);
    if (!this.sitting) {
      g.globalAlpha *= 0.35;
      rect(g, x + 4, Math.round(this.y), 8, 2, "#000");
      rect(g, x + 3, Math.round(this.y) + 1, 10, 1, "#000");
      g.globalAlpha = Math.max(0, this.alpha);
    }
    if (selected) {
      const pulse = Math.floor(t * 4) % 2;
      rect(g, x + 2 - pulse, Math.round(this.y) + 2, 12 + pulse * 2, 1, "#ffd43b");
    }
    g.drawImage(sprite, x, y);
    // blink: brief eyelids when facing the viewer
    const facingViewer = (!this.sitting && this.dir === "down" && !walking) || (this.sitting && this.goal === "lounge");
    if (facingViewer && (t + this.phase * 3) % 4.2 < 0.13) {
      rect(g, x + 6, y + 9, 1, 2, this.look.skin);
      rect(g, x + 9, y + 9, 1, 2, this.look.skin);
      rect(g, x + 6, y + 10, 1, 1, "#1d1a2b");
      rect(g, x + 9, y + 10, 1, 1, "#1d1a2b");
    }
    if (this.sitting && this.goal === "seat" && this.seat) office.chairBack(g, this.seat.px, this.seat.py);
    // status marks above head
    if (agent?.status === "retry") rect(g, x + 13, y + 5 + (Math.floor(t * 3) % 2), 2, 3, "#74c0fc");
    if (agent?.status === "idle" && !agent.parentId && this.sitting && this.goal === "lounge") {
      const k = (t * 0.7) % 1;
      g.globalAlpha = 1 - k;
      rect(g, x + 12 + Math.round(k * 3), y + 2 - Math.round(k * 6), 3, 1, "#e9ecef");
      g.globalAlpha = 1;
    }
    g.globalAlpha = 1;
  }

  hit(wx: number, wy: number) {
    return wx >= this.x - 7 && wx <= this.x + 7 && wy >= this.y - CHAR_FEET + 3 && wy <= this.y + 2;
  }
}

/** The office cat: wanders between free tiles, sits, and naps on the sofa when it's free. */
export class Cat {
  x: number;
  y: number;
  private flip = false;
  private path: { x: number; y: number }[] = [];
  private mode: "walk" | "sit" | "sleep" = "sit";
  private until = 0;
  private walkT = 0;

  constructor(office: Office) {
    const t = office.randomFreeTile();
    this.x = t.tx * T + 8;
    this.y = t.ty * T + 12;
    this.until = performance.now() + 3000;
  }

  update(dt: number, office: Office, now: number) {
    if (this.path.length) {
      this.walkT += dt;
      let budget = 22 * dt;
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
        this.mode = this.mode === "sleep" ? "sleep" : "sit";
        this.until = now + (this.mode === "sleep" ? 25_000 : 4000 + Math.random() * 8000);
      }
      return;
    }
    if (now < this.until) return;
    // pick the next destination: sometimes a nap on a free sofa seat
    const sofa = office.spots.find((s) => s.sit && !office.isSpotTaken(s.id));
    let target: Tile;
    if (sofa && Math.random() < 0.3) {
      target = sofa;
      this.mode = "sleep";
    } else {
      target = office.randomFreeTile();
      this.mode = "walk";
    }
    this.path = office.path({ tx: Math.floor(this.x / T), ty: Math.floor(this.y / T) }, target).map((t) => ({ x: t.tx * T + 8, y: t.ty * T + 12 }));
    if (this.mode === "sleep") this.path.push({ x: target.tx * T + 8, y: target.ty * T + 9 });
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const walking = this.path.length > 0;
    const pose: CatPose = walking ? (Math.floor(this.walkT * 6) % 2 ? "walk1" : "walk0") : this.mode === "sleep" ? "sleep" : "sit";
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
  }
}
