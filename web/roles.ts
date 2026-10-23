// Agent name → office zone + look. Covers oh-my-opencode-slim, classic oh-my-opencode and opencode built-ins.

export type Zone = "boss" | "library" | "oracle" | "studio" | "workbench" | "review" | "open" | "temp";
export type Accessory = "crown" | "cap" | "glasses" | "hardhat" | "beret" | "wizard" | "visor" | "headset" | "none";

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  acc: Accessory;
  accColor: string;
}

export interface Role {
  zone: Zone;
  label: string;
  shirt: string;
  acc: Accessory;
  accColor: string;
}

const boss: Role = { zone: "boss", label: "Orchestrator", shirt: "#3b5bdb", acc: "crown", accColor: "#ffd43b" };
const explorer: Role = { zone: "library", label: "Explorer", shirt: "#2f9e44", acc: "cap", accColor: "#1f6f35" };
const librarian: Role = { zone: "library", label: "Librarian", shirt: "#9c6644", acc: "glasses", accColor: "#1d1a2b" };
const oracle: Role = { zone: "oracle", label: "Oracle", shirt: "#7048e8", acc: "wizard", accColor: "#5f3dc4" };
const fixer: Role = { zone: "workbench", label: "Fixer", shirt: "#e8590c", acc: "hardhat", accColor: "#fcc419" };
const designer: Role = { zone: "studio", label: "Designer", shirt: "#d6336c", acc: "beret", accColor: "#c92a2a" };
const reviewer: Role = { zone: "review", label: "Reviewer", shirt: "#495057", acc: "visor", accColor: "#40c057" };

const ROLES: Record<string, Role> = {
  orchestrator: boss,
  sisyphus: boss,
  atlas: { ...boss, label: "Atlas" },
  hephaestus: { ...boss, label: "Hephaestus" },
  prometheus: { ...boss, label: "Planner" },
  build: { ...boss, label: "Build" },
  plan: { ...boss, label: "Plan", shirt: "#1971c2" },
  explorer,
  explore: explorer,
  general: { ...explorer, label: "General", shirt: "#0c8599", acc: "headset", accColor: "#343a40" },
  librarian,
  oracle,
  metis: { ...oracle, label: "Metis", shirt: "#9c36b5" },
  momus: { ...oracle, label: "Momus", shirt: "#862e9c" },
  council: { ...oracle, label: "Council" },
  fixer,
  "sisyphus-junior": { ...fixer, label: "Junior" },
  designer,
  "frontend-ui-ux-engineer": { ...designer, label: "Frontend" },
  "multimodal-looker": { ...designer, label: "Looker", shirt: "#e64980" },
  "document-writer": { ...designer, label: "Writer", shirt: "#f08c00" },
  reviewer,
  observer: { ...reviewer, label: "Observer" },
};

const SHIRTS = ["#0ca678", "#1098ad", "#f59f00", "#ae3ec9", "#74b816", "#f76707", "#4263eb", "#e8590c"];
const SKINS = ["#ffdbac", "#f1c27d", "#e0ac69", "#c68642", "#8d5524"];
const HAIRS = ["#2b1d14", "#4a2f1b", "#7a4a26", "#c08a3e", "#e8c372", "#1c1c24", "#8c8c99", "#a2422b"];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function roleOf(name: string): Role {
  const key = name.toLowerCase().replace(/^@/, "").trim();
  return (
    ROLES[key] ??
    ROLES[key.split(/[\s(:]/)[0]] ?? {
      zone: "open",
      label: name,
      shirt: SHIRTS[hash(key) % SHIRTS.length],
      acc: "none",
      accColor: "#000",
    }
  );
}

/** Role decides clothes; session id varies skin/hair so parallel explorers look different. */
export function lookOf(name: string, id: string): Look {
  const r = roleOf(name);
  const h = hash(id);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 4) % HAIRS.length],
    shirt: r.shirt,
    pants: "#343a52",
    acc: r.acc,
    accColor: r.accColor,
  };
}

export const STATUS_COLOR: Record<string, string> = {
  busy: "#51cf66",
  idle: "#adb5bd",
  retry: "#fcc419",
  error: "#ff6b6b",
  done: "#748ffc",
  waiting: "#ffa94d",
};

export const STATUS_LABEL: Record<string, string> = {
  busy: "arbeitet",
  idle: "wartet",
  retry: "Retry",
  error: "Fehler",
  done: "fertig",
  waiting: "braucht Freigabe",
};

// ---------- permanent staff ----------

/** Which permanent team an agent name belongs to (tasks of that kind go to that team's people). */
const TEAM_OF: Record<string, string> = {
  orchestrator: "orchestrator", sisyphus: "orchestrator", atlas: "orchestrator", hephaestus: "orchestrator",
  prometheus: "orchestrator", build: "orchestrator", plan: "orchestrator",
  explorer: "explorer", explore: "explorer", general: "explorer",
  librarian: "librarian",
  oracle: "oracle", metis: "oracle", momus: "oracle", council: "oracle",
  fixer: "fixer", "sisyphus-junior": "fixer",
  designer: "designer", "frontend-ui-ux-engineer": "designer", "multimodal-looker": "designer", "document-writer": "designer",
  reviewer: "reviewer", observer: "reviewer",
};

export function teamOf(agentName: string): string | undefined {
  const key = agentName.toLowerCase().replace(/^@/, "").trim();
  return TEAM_OF[key] ?? TEAM_OF[key.split(/[\s(:]/)[0]];
}

export interface StaffDef {
  key: string;
  name: string;
  team: string;
}

/** Always in the office. Order matters: it decides who gets which desk and who is asked first. */
export const STAFF: StaffDef[] = [
  { key: "otto", name: "Otto", team: "orchestrator" },
  { key: "ella", name: "Ella", team: "explorer" },
  { key: "emil", name: "Emil", team: "explorer" },
  { key: "lotte", name: "Lotte", team: "librarian" },
  { key: "orla", name: "Orla", team: "oracle" },
  { key: "fritz", name: "Fritz", team: "fixer" },
  { key: "frieda", name: "Frieda", team: "fixer" },
  { key: "dani", name: "Dani", team: "designer" },
  { key: "rita", name: "Rita", team: "reviewer" },
];

export const TEMP_NAMES = ["Aushilfe Tim", "Aushilfe Mia", "Aushilfe Ben", "Aushilfe Zoe", "Aushilfe Kai", "Aushilfe Lia", "Aushilfe Max", "Aushilfe Ida"];
