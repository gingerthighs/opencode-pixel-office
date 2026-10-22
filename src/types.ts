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

export interface Agent {
  id: string;
  roomId: string;
  parentId?: string;
  name: string;
  title: string;
  status: AgentStatus;
  waiting: boolean;
  tool?: ToolInfo;
  snippet?: Snippet;
  todos: Todo[];
  tokens: number;
  cost: number;
  model?: string;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
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

export interface Snapshot {
  rooms: Room[];
  agents: AgentView[];
  now: number;
}

export type Op =
  | { op: "room"; room: Room }
  | { op: "room-remove"; id: string }
  | { op: "agent"; agent: Agent }
  | { op: "agent-remove"; id: string }
  | { op: "feed"; id: string; entry: FeedEntry }
  | { op: "delegate"; from: string; to: string; label: string };
