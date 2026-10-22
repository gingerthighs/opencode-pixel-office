// Screen-space speech bubbles and name tags.

import type { Agent } from "../src/types.ts";
import type { ClientState } from "./state.ts";
import { icon, OUTLINE, toolIcon, type IconName } from "./sprites.ts";

export const FONT = '"Pixelify Sans", ui-monospace, monospace';

const TOOL_LINGER = 2500;
const TEXT_LINGER = 4000;

export interface BubbleContent {
  icon: IconName;
  text: string;
  tone: "normal" | "warn" | "error";
}

export function bubbleFor(a: Agent, state: ClientState, selected: boolean): BubbleContent | undefined {
  if (a.waiting) return { icon: "question", text: "braucht Freigabe", tone: "warn" };
  if (a.status === "error") return { icon: "alert", text: "Fehler", tone: "error" };
  const tool = a.tool;
  const toolLive = tool && (tool.state === "running" || tool.state === "pending" || state.age(tool.at) < TOOL_LINGER);
  const snip = a.snippet;
  const snipLive = snip && state.age(snip.at) < TEXT_LINGER;
  if (a.status === "busy" || a.status === "retry" || selected) {
    if (toolLive && (!snipLive || tool!.at >= snip!.at)) {
      return { icon: tool!.state === "error" ? "alert" : toolIcon(tool!.name), text: tool!.title || tool!.name, tone: tool!.state === "error" ? "error" : "normal" };
    }
    if (snipLive) return { icon: snip!.kind === "think" ? "think" : "speech", text: snip!.text, tone: "normal" };
  }
  if (selected) {
    if (a.status === "done") return { icon: "check", text: "fertig", tone: "normal" };
    if (a.status === "idle") return { icon: "zzz", text: "wartet auf Input", tone: "normal" };
    if (tool) return { icon: toolIcon(tool.name), text: tool.title || tool.name, tone: "normal" };
  }
}

function truncate(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Draws a bubble whose tail points at (x, y). Returns its rect for collision nudging. */
export function drawBubble(g: CanvasRenderingContext2D, x: number, y: number, b: BubbleContent, maxW: number) {
  const fs = 12;
  g.font = `${fs}px ${FONT}`;
  const iconS = 16;
  const pad = 5;
  const text = truncate(g, b.text, maxW - iconS - pad * 3);
  const w = Math.ceil(iconS + pad * 3 + g.measureText(text).width);
  const h = iconS + pad * 2;
  const bx = Math.round(Math.max(4, Math.min(g.canvas.width / devicePixelRatio - w - 4, x - w / 2)));
  const by = Math.round(y - h - 7);
  const fill = b.tone === "error" ? "#ffe3e3" : b.tone === "warn" ? "#fff3bf" : "#f8f9fa";
  g.fillStyle = OUTLINE;
  g.fillRect(bx - 2, by, w + 4, h);
  g.fillRect(bx, by - 2, w, h + 4);
  g.fillStyle = fill;
  g.fillRect(bx, by, w, h);
  // tail
  const tx = Math.round(Math.max(bx + 6, Math.min(bx + w - 10, x - 3)));
  g.fillStyle = OUTLINE;
  g.fillRect(tx - 1, by + h, 8, 3);
  g.fillRect(tx + 1, by + h + 3, 4, 2);
  g.fillRect(tx + 2, by + h + 5, 2, 2);
  g.fillStyle = fill;
  g.fillRect(tx + 1, by + h, 4, 2);
  g.fillRect(tx + 2, by + h + 2, 2, 2);
  g.imageSmoothingEnabled = false;
  g.drawImage(icon(b.icon), bx + pad, by + pad, iconS, iconS);
  g.fillStyle = "#1d1a2b";
  g.textBaseline = "middle";
  g.fillText(text, bx + pad * 2 + iconS, by + h / 2 + 1);
  return { x: bx, y: by - 2, w, h: h + 4 };
}

export function drawNameTag(g: CanvasRenderingContext2D, x: number, y: number, name: string, color: string) {
  g.font = `10px ${FONT}`;
  const w = Math.ceil(g.measureText(name).width) + 10;
  const bx = Math.round(x - w / 2);
  const by = Math.round(y);
  g.globalAlpha = 0.85;
  g.fillStyle = "#16121f";
  g.fillRect(bx, by, w, 13);
  g.globalAlpha = 1;
  g.fillStyle = color;
  g.fillRect(bx + 3, by + 5, 3, 3);
  g.fillStyle = "#e9e4ff";
  g.textBaseline = "middle";
  g.fillText(name, bx + 8, by + 7);
}
