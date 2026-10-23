// Screen-space speech bubbles and name tags (measured first, then laid out without overlaps).

import type { Agent } from "../src/types.ts";
import type { ClientState } from "./state.ts";
import { icon, OUTLINE, toolIcon, type IconName } from "./sprites.ts";

export const FONT = '"Pixelify Sans", ui-monospace, monospace';

const TOOL_LINGER = 2500;
const TEXT_LINGER = 4000;

export interface BubbleContent {
  icon: IconName;
  text: string;
  tone: "normal" | "warn" | "error" | "think";
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function bubbleFor(a: Agent, state: ClientState, focused: boolean): BubbleContent | undefined {
  if (a.waiting) return { icon: "question", text: "needs approval / an answer", tone: "warn" };
  if (a.status === "error") return { icon: "alert", text: "error", tone: "error" };
  const tool = a.tool;
  const toolLive = tool && (tool.state === "running" || tool.state === "pending" || state.age(tool.at) < TOOL_LINGER);
  const snip = a.snippet;
  const snipLive = snip && state.age(snip.at) < TEXT_LINGER;
  if (a.status === "busy" || a.status === "retry" || focused) {
    if (toolLive && (!snipLive || tool!.at >= snip!.at)) {
      const err = tool!.state === "error";
      return { icon: err ? "alert" : toolIcon(tool!.name), text: tool!.title || tool!.name, tone: err ? "error" : "normal" };
    }
    if (snipLive) return { icon: snip!.kind === "think" ? "think" : "speech", text: snip!.text, tone: snip!.kind === "think" ? "think" : "normal" };
  }
  if (focused) {
    if (a.status === "done") return { icon: "check", text: "done", tone: "normal" };
    if (a.status === "idle") return { icon: "zzz", text: "waiting for input", tone: "normal" };
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

const BUBBLE_FS = 12;
const ICON_S = 16;
const PAD = 5;
const TAIL = 7;

export interface MeasuredBubble {
  b: BubbleContent;
  text: string;
  w: number;
  h: number;
}

export function measureBubble(g: CanvasRenderingContext2D, b: BubbleContent, maxW: number): MeasuredBubble {
  g.font = `${BUBBLE_FS}px ${FONT}`;
  const text = truncate(g, b.text, maxW - ICON_S - PAD * 3);
  return { b, text, w: Math.ceil(ICON_S + PAD * 3 + g.measureText(text).width), h: ICON_S + PAD * 2 + TAIL };
}

const FILL: Record<BubbleContent["tone"], string> = {
  normal: "#f8f9fa",
  warn: "#fff3bf",
  error: "#ffe3e3",
  think: "#f3f0ff",
};

/** Draws a bubble at box (x,y = top-left incl. tail space below); tail points at tailX. */
export function drawBubble(g: CanvasRenderingContext2D, m: MeasuredBubble, x: number, y: number, tailX: number) {
  const h = m.h - TAIL;
  const w = m.w;
  const bx = Math.round(x);
  const by = Math.round(y);
  const fill = FILL[m.b.tone];
  // drop shadow
  g.globalAlpha = 0.35;
  g.fillStyle = "#000";
  g.fillRect(bx, by + 3, w + 2, h);
  g.globalAlpha = 1;
  g.fillStyle = OUTLINE;
  g.fillRect(bx - 2, by, w + 4, h);
  g.fillRect(bx, by - 2, w, h + 4);
  g.fillStyle = fill;
  g.fillRect(bx, by, w, h);
  g.fillStyle = "rgba(0,0,0,0.06)";
  g.fillRect(bx, by + h - 3, w, 3);
  const tx = Math.round(Math.max(bx + 6, Math.min(bx + w - 10, tailX - 3)));
  g.fillStyle = OUTLINE;
  if (m.b.tone === "think") {
    g.fillRect(tx, by + h + 2, 4, 3);
    g.fillRect(tx + 2, by + h + 6, 2, 2);
    g.fillStyle = fill;
    g.fillRect(tx + 1, by + h + 3, 2, 1);
  } else {
    g.fillRect(tx - 1, by + h, 8, 3);
    g.fillRect(tx + 1, by + h + 3, 4, 2);
    g.fillRect(tx + 2, by + h + 5, 2, 2);
    g.fillStyle = fill;
    g.fillRect(tx + 1, by + h, 4, 2);
    g.fillRect(tx + 2, by + h + 2, 2, 2);
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(icon(m.b.icon), bx + PAD, by + PAD, ICON_S, ICON_S);
  g.font = `${BUBBLE_FS}px ${FONT}`;
  g.fillStyle = "#1d1a2b";
  g.textBaseline = "middle";
  g.fillText(m.text, bx + PAD * 2 + ICON_S, by + h / 2 + 1);
}

export const TAG_H = 14;

export function measureTag(g: CanvasRenderingContext2D, name: string) {
  g.font = `10px ${FONT}`;
  return Math.ceil(g.measureText(name).width) + 13;
}

export function drawNameTag(g: CanvasRenderingContext2D, x: number, y: number, w: number, name: string, color: string, focused: boolean) {
  const bx = Math.round(x);
  const by = Math.round(y);
  g.globalAlpha = 0.9;
  g.fillStyle = focused ? "#3a2f12" : "#16121f";
  g.fillRect(bx, by, w, TAG_H);
  g.globalAlpha = 1;
  if (focused) {
    g.fillStyle = "#ffd43b";
    g.fillRect(bx, by + TAG_H - 1, w, 1);
  }
  g.fillStyle = color;
  g.fillRect(bx + 4, by + 5, 4, 4);
  g.font = `10px ${FONT}`;
  g.fillStyle = "#f1ecff";
  g.textBaseline = "middle";
  g.fillText(name, bx + 10, by + TAG_H / 2 + 1);
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
