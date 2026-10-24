// Shared between plugin (server) and web UI.

export type AgentStatus = "idle" | "busy" | "retry" | "error" | "done";

export type ToolState = "pending" | "running" | "completed" | "error";

export interface ToolInfo {
  name: string;
  title: string;
  state: ToolState;
  callId: string;
  at: number;
}

export type FeedKind = "tool" | "text" | "think" | "prompt" | "status" | "spawn" | "error" | "todo" | "ask";

export interface FeedEntry {
  ts: number;
  kind: FeedKind;
  text: string;
}

export interface Todo {
  content: string;
  status: string;
  priority?: string;
}

export interface Snippet {
  text: string;
  kind: "text" | "think";
  at: number;
}

/** an open permission request or question the agent is blocked on */
export interface Ask {
  kind: "permission" | "question";
  id?: string;
  title: string;
  detail?: string;
  options?: string[];
}

export interface Agent {
  id: string;
  roomId: string;
  parentId?: string;
  name: string;
  title: string;
  status: AgentStatus;
  waiting: boolean;
  ask?: Ask;
  /** files written/edited by this agent (most recent last) */
  files: string[];
  /** number of completed write/edit tool calls */
  edits: number;
  tool?: ToolInfo;
  snippet?: Snippet;
  todos: Todo[];
  tokens: number;
  cost: number;
  model?: string;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  /** Receipt time of an incoming session event, never advanced by timer flushes. */
  lastActivityAt: number;
  waitingSince?: number;
  failure?: { at: number; message: string };
  outcome?: "completed" | "failed" | "interrupted";
  completedAt?: number;
}

export interface Room {
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentView extends Agent {
  feed: FeedEntry[];
}

export type ActivityState = "working" | "retrying" | "waiting" | "idle" | "failed";

export interface ActivityInterval {
  state: ActivityState;
  start: number;
  end?: number;
}

export interface ActivityRecord {
  agent: AgentView;
  firstObservedAt: number;
  intervals: ActivityInterval[];
  archived: boolean;
  truncated: boolean;
}

export interface Snapshot {
  rooms: Room[];
  agents: AgentView[];
  now: number;
  history: ActivityRecord[];
  historyTruncated: boolean;
}

export type ControlRequest =
  | { action: "permission"; sessionID: string; requestID: string; decision: "once" | "always" | "reject" }
  | { action: "interrupt"; sessionID: string };

export type Op =
  | { op: "room"; room: Room }
  | { op: "room-remove"; id: string }
  | { op: "agent"; agent: Agent }
  | { op: "agent-remove"; id: string }
  | { op: "history"; record: ActivityRecord }
  | { op: "history-remove"; id: string }
  | { op: "history-truncated" }
  | { op: "feed"; id: string; entry: FeedEntry }
  | { op: "delegate"; from: string; to: string; label: string };
