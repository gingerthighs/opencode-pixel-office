// Standalone demo: serves the UI and replays a fake oh-my-opencode-slim run in a loop.
// node scripts/mock.ts   (PIXEL_OFFICE_PORT / PIXEL_OFFICE_HOST / PIXEL_OFFICE_TOKEN respected)

import { HTML, JS } from "../src/assets.generated.ts";
import { loadConfig } from "../src/config.ts";
import { Hub } from "../src/server.ts";
import { Store } from "../src/store.ts";

const cfg = loadConfig({ host: "127.0.0.1" });
const hub = new Hub(new Store(), { ...cfg, html: HTML, js: JS });
await hub.listen();
console.log(`Pixel Office mock: http://${cfg.host}:${cfg.port}/${cfg.token ? "?token=" + cfg.token : ""}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6)));
const emit = (type: string, properties: unknown) => hub.ingest({ type, properties });
let seq = 0;
const uid = (p: string) => `${p}_${(++seq).toString(36)}`;

function session(id: string, title: string, directory: string, parentID?: string, agent?: string) {
  emit("session.created", { info: { id, title, directory, parentID, agent, time: { created: Date.now(), updated: Date.now() } } });
}
const status = (id: string, type: "busy" | "idle") =>
  type === "idle" ? emit("session.idle", { sessionID: id }) : emit("session.status", { sessionID: id, status: { type } });

function message(sessionID: string, role: "user" | "assistant", agent: string, tokens = 0) {
  const id = uid("msg");
  emit("message.updated", {
    info: { id, sessionID, role, agent, modelID: "glm-5.3-flash-free", cost: tokens * 0.0000002, tokens: { input: tokens, output: tokens / 4, reasoning: 0, cache: { read: 0, write: 0 } } },
  });
  return id;
}

async function say(sessionID: string, messageID: string, text: string, kind: "text" | "reasoning" = "text") {
  const id = uid("part");
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i += 3) {
    emit("message.part.updated", { part: { id, sessionID, messageID, type: kind, text: words.slice(0, i).join(" "), time: { start: Date.now() } } });
    await sleep(120);
  }
  emit("message.part.updated", { part: { id, sessionID, messageID, type: kind, text, time: { start: Date.now(), end: Date.now() } } });
}

async function tool(sessionID: string, messageID: string, name: string, input: Record<string, unknown>, ms: number, fail = false) {
  const id = uid("part");
  const callID = uid("call");
  const part = (state: object) => ({ part: { id, sessionID, messageID, type: "tool", tool: name, callID, state } });
  emit("message.part.updated", part({ status: "pending", input: {}, raw: "" }));
  await sleep(150);
  emit("message.part.updated", part({ status: "running", input, time: { start: Date.now() } }));
  await sleep(ms);
  emit(
    "message.part.updated",
    part(fail ? { status: "error", input, error: "Command failed: exit code 1", time: { start: 0, end: Date.now() } } : { status: "completed", input, output: "ok", title: "", metadata: {}, time: { start: 0, end: Date.now() } }),
  );
}

async function subagent(parent: string, parentMsg: string, agent: string, desc: string, dir: string, work: (id: string, msg: string) => Promise<void>) {
  const id = uid("ses");
  const call = tool(parent, parentMsg, "task", { subagent_type: agent, description: desc, prompt: desc }, 300);
  await sleep(250);
  session(id, `${desc} (@${agent} subagent)`, dir, parent, agent);
  const um = message(id, "user", agent);
  emit("message.part.updated", { part: { id: uid("part"), sessionID: id, messageID: um, type: "text", text: desc } });
  status(id, "busy");
  const am = message(id, "assistant", agent, 4000);
  await work(id, am);
  message(id, "assistant", agent, 9000 + Math.random() * 20000);
  status(id, "idle");
  await call;
}

async function bigRun() {
  const dir = "/home/luis/homenet-panel";
  const root = uid("ses");
  session(root, "Auth auf OAuth umbauen", dir);
  const um = message(root, "user", "orchestrator");
  emit("message.part.updated", { part: { id: uid("part"), sessionID: root, messageID: um, type: "text", text: "Bau das Login auf OAuth um und mach das UI schöner" } });
  status(root, "busy");
  const m = message(root, "assistant", "orchestrator", 12000);
  await say(root, m, "Plan the migration: find current auth, check provider docs, then implement and review", "reasoning");
  const todos = [
    { id: "1", content: "Bestehenden Auth-Code finden", status: "in_progress", priority: "high" },
    { id: "2", content: "OAuth Provider Docs lesen", status: "pending", priority: "high" },
    { id: "3", content: "Login-Flow implementieren", status: "pending", priority: "high" },
    { id: "4", content: "Login UI überarbeiten", status: "pending", priority: "medium" },
    { id: "5", content: "Review + Tests", status: "pending", priority: "medium" },
  ];
  const setTodo = (i: number, s: string) => {
    todos[i].status = s;
    emit("todo.updated", { sessionID: root, todos });
  };
  emit("todo.updated", { sessionID: root, todos });
  await tool(root, m, "todowrite", { todos }, 400);

  await Promise.all([
    subagent(root, m, "explorer", "Finde Auth-Middleware", dir, async (id, am) => {
      await tool(id, am, "grep", { pattern: "session|jwt|login" }, 1400);
      await tool(id, am, "glob", { pattern: "src/**/auth*.ts" }, 900);
      await tool(id, am, "read", { filePath: "src/server/auth/middleware.ts" }, 1600);
      await say(id, am, "Auth lives in src/server/auth: cookie sessions, bcrypt, no refresh tokens.");
    }),
    subagent(root, m, "explorer", "Finde Login-Routen + Tests", dir, async (id, am) => {
      await tool(id, am, "grep", { pattern: "router.post('/login'" }, 1100);
      await tool(id, am, "read", { filePath: "src/routes/login.ts" }, 1300);
      await tool(id, am, "read", { filePath: "test/login.test.ts" }, 1000);
    }),
    subagent(root, m, "librarian", "OAuth PKCE Docs recherchieren", dir, async (id, am) => {
      await tool(id, am, "websearch", { query: "oauth 2.1 pkce node best practice" }, 1800);
      await tool(id, am, "webfetch", { url: "https://oauth.net/2/pkce/" }, 2200);
      await say(id, am, "PKCE with S256 is required for public clients; use state + nonce, rotate refresh tokens.");
    }),
  ]);
  setTodo(0, "completed");
  setTodo(1, "completed");
  setTodo(2, "in_progress");

  await subagent(root, m, "oracle", "Architektur-Check Token-Storage", dir, async (id, am) => {
    await say(id, am, "Weighing httpOnly cookies vs. in-memory tokens with silent refresh, considering XSS and CSRF tradeoffs", "reasoning");
    await say(id, am, "Recommend httpOnly SameSite=Lax cookie for refresh token, short-lived access token in memory.");
  });

  emit("permission.asked", { id: "perm1", sessionID: root, permission: "bash", patterns: ["npm install openid-client"] });
  await sleep(2500);
  emit("permission.replied", { sessionID: root, requestID: "perm1", reply: "once" });
  await tool(root, m, "bash", { command: "npm install openid-client", description: "Install OAuth client" }, 1500);

  await Promise.all([
    subagent(root, m, "fixer", "OAuth Flow implementieren", dir, async (id, am) => {
      await tool(id, am, "read", { filePath: "src/server/auth/middleware.ts" }, 700);
      await tool(id, am, "edit", { filePath: "src/server/auth/oauth.ts" }, 2000);
      await tool(id, am, "edit", { filePath: "src/routes/login.ts" }, 1600);
      await tool(id, am, "bash", { command: "npm test", description: "Run tests" }, 2200, true);
      await say(id, am, "One test fails: missing redirect_uri in config. Fixing.");
      await tool(id, am, "edit", { filePath: "config/default.json" }, 900);
      await tool(id, am, "bash", { command: "npm test", description: "Run tests" }, 2000);
    }),
    subagent(root, m, "designer", "Login UI im Pixel-Look", dir, async (id, am) => {
      await tool(id, am, "read", { filePath: "web/pages/login.tsx" }, 900);
      await say(id, am, "Going for a centered card, provider buttons with icons, subtle gradient background.");
      await tool(id, am, "write", { filePath: "web/pages/login.tsx" }, 2600);
      await tool(id, am, "edit", { filePath: "web/styles/login.css" }, 1500);
    }),
  ]);
  setTodo(2, "completed");
  setTodo(3, "completed");
  setTodo(4, "in_progress");

  await subagent(root, m, "reviewer", "Review der Änderungen", dir, async (id, am) => {
    await tool(id, am, "bash", { command: "git diff --stat", description: "Show diff" }, 900);
    await tool(id, am, "bash", { command: "git diff", description: "Show diff" }, 1400);
    await say(id, am, "LGTM. Minor: add rate limit on /auth/callback. No blockers.");
  });
  setTodo(4, "completed");
  await say(root, m, "Fertig: OAuth mit PKCE, neues Login-UI, Tests grün. Ein Nit vom Reviewer offen (Rate Limit).");
  message(root, "assistant", "orchestrator", 30000);
  status(root, "idle");
  return root;
}

async function smallRun() {
  const dir = "/home/luis/dotfiles";
  const root = uid("ses");
  session(root, "README aufräumen", dir);
  status(root, "busy");
  const m = message(root, "assistant", "orchestrator", 3000);
  await subagent(root, m, "explorer", "Finde alle Docs", dir, async (id, am) => {
    await tool(id, am, "glob", { pattern: "**/*.md" }, 1200);
  });
  await tool(root, m, "edit", { filePath: "README.md" }, 2500);
  status(root, "idle");
  return root;
}

for (;;) {
  const [a, b] = await Promise.all([bigRun(), (async () => (await sleep(4000), smallRun()))()]);
  await sleep(25_000);
  emit("session.deleted", { info: { id: b } });
  await sleep(5_000);
  emit("session.deleted", { info: { id: a } });
  await sleep(1_000);
}
