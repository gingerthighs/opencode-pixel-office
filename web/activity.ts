import type { ActivityInterval, ActivityRecord, ActivityState } from "../src/types.ts";
import type { ClientState } from "./state.ts";

export const ACTIVITY_COLOR: Record<ActivityState, string> = {
  working: "#51cf66", retrying: "#b197fc", waiting: "#ffd43b", idle: "#868e96", failed: "#ff6b6b",
};
export const INACTIVE_AFTER = 10 * 60_000;
export const TIMELINE_WINDOWS = [15, 60, 120] as const;

export function clipIntervals(intervals: ActivityInterval[], start: number, now: number): ActivityInterval[] {
  return intervals.flatMap((interval) => {
    const from = Math.max(start, interval.start);
    const to = Math.min(now, interval.end ?? now);
    return to > from ? [{ state: interval.state, start: from, end: to }] : [];
  });
}

export function activityTotals(intervals: ActivityInterval[], start: number, now: number) {
  const clipped = clipIntervals(intervals, start, now);
  const duration = (state: ActivityState) => clipped.filter((i) => i.state === state).reduce((sum, i) => sum + i.end! - i.start, 0);
  return { working: duration("working"), waiting: duration("waiting") };
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface AttentionItem {
  record: ActivityRecord;
  kind: "approval" | "question" | "failure" | "inactive";
  since: number;
  text: string;
}

export function attentionItems(state: ClientState): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = state.observedNow();
  const inactivityNow = state.inactivityNow();
  for (const record of state.history.values()) {
    const a = record.agent;
    if (!record.archived && a.waiting && a.ask) {
      items.push({ record, kind: a.ask.kind === "permission" ? "approval" : "question", since: a.waitingSince ?? a.lastActivityAt, text: a.ask.title });
    } else if (a.failure) {
      items.push({ record, kind: "failure", since: a.failure.at, text: a.failure.message });
    } else if (!record.archived && inactivityNow !== undefined && (a.status === "busy" || a.status === "retry") && inactivityNow - a.lastActivityAt >= INACTIVE_AFTER) {
      items.push({ record, kind: "inactive", since: a.lastActivityAt, text: `No observed activity for ${duration(now - a.lastActivityAt)}` });
    }
  }
  const rank = { approval: 0, question: 0, failure: 1, inactive: 2 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.since - b.since || a.record.agent.id.localeCompare(b.record.agent.id));
}

/** Used by timeline and attention rows, including records no longer on canvas. */
export function focusActivity(state: ClientState, id: string, pickRoom: (roomId: string) => void, select: (id: string) => void) {
  const agent = state.detailAgent(id);
  if (!agent || !state.rooms.has(agent.roomId)) return;
  pickRoom(agent.roomId);
  select(id);
}
