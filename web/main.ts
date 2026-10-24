import type { Op, Snapshot } from "../src/types.ts";
import { Controls } from "./controls.ts";
import { Panel } from "./panel.ts";
import { Scene } from "./scene.ts";
import { ClientState } from "./state.ts";
import { Timeline } from "./timeline.ts";
import { Attention } from "./attention.ts";
import { focusActivity } from "./activity.ts";

const store = {
  get(k: string) {
    try {
      return localStorage.getItem("po:" + k) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(k: string, v: string | undefined) {
    try {
      if (v === undefined) localStorage.removeItem("po:" + k);
      else localStorage.setItem("po:" + k, v);
    } catch {
      /* private mode */
    }
  },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = new ClientState();
const scene = new Scene($<HTMLCanvasElement>("office"), state);
const follow = $<HTMLInputElement>("follow");
const showAll = $<HTMLInputElement>("show-all");
const threads = $<HTMLInputElement>("threads");
const timelineToggle = $<HTMLInputElement>("timeline-toggle");
const buildingBtn = $<HTMLButtonElement>("building");
const timelineEl = $<HTMLElement>("timeline");
const conn = $<HTMLElement>("conn");
const attentionPanel = $<HTMLDetailsElement>("attention");
attentionPanel.open = !matchMedia("(max-width: 860px)").matches;
$<HTMLButtonElement>("attention-button").onclick = () => {
  attentionPanel.open = true;
  attentionPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  attentionPanel.querySelector("summary")?.focus();
};

const controls = new Controls(fetch, () => (dirty = true));
void controls.refresh();

let roomId = store.get("room");
let selected: string | undefined;
let rendered = -1;
let dirty = true;

// ?threads=1&timeline=1&follow=0&view=building override the remembered toggles (handy for links)
const params = new URLSearchParams(location.search);

const bindToggle = (el: HTMLInputElement, key: string, def: boolean, apply: (on: boolean) => void) => {
  el.checked = (params.get(key) ?? store.get(key) ?? (def ? "1" : "0")) === "1";
  apply(el.checked);
  el.onchange = () => {
    store.set(key, el.checked ? "1" : "0");
    apply(el.checked);
    dirty = true;
  };
};
bindToggle(follow, "follow", true, () => {});
bindToggle(threads, "threads", false, (on) => (scene.showThreads = on));
bindToggle(timelineToggle, "timeline", false, (on) => document.body.classList.toggle("with-timeline", on));
showAll.onchange = () => (dirty = true);

buildingBtn.onclick = () => scene.setMode(scene.mode === "building" ? "office" : "building");
scene.onModeChange = (mode) => buildingBtn.classList.toggle("active", mode === "building");
if (params.get("view") === "building") scene.setMode("building");

function pickRoom(id: string) {
  roomId = id;
  store.set("room", id);
  follow.checked = false;
  store.set("follow", "0");
  selected = undefined;
  dirty = true;
}

const select = (key: string | undefined) => {
  selected = key;
  dirty = true;
};

const panel = new Panel(state, {
  selectRoom: pickRoom,
  select,
  control: (req) => controls.send(req),
  caps: () => controls.caps,
  workerName: (id) => scene.workerName(id),
  personInfo: (key) => scene.personInfo(key),
  roster: () => scene.roster(),
});
const focusAgent = (id: string) => focusActivity(state, id, pickRoom, select);
const timeline = new Timeline(timelineEl, state, (id) => scene.workerName(id), focusAgent);
const attention = new Attention(state, $("attention-list"), $("attention-count"), $("connection-warning"), focusAgent, (id) => scene.workerName(id));

scene.onSelect = select;
scene.onPickRoom = pickRoom;

/** Pick the room to show: followed = most recently active one, else keep the chosen one if it still exists. */
function chooseRoom() {
  const rooms = panel.visibleRooms(roomId);
  if (follow.checked) {
    // stay while the current room is busy, otherwise jump to the most recently active busy room
    const stay = roomId && state.rooms.has(roomId) ? roomId : undefined;
    const busy = rooms.find((r) => state.roomBusy(r.id));
    const next = stay && state.roomBusy(stay) ? stay : busy?.id ?? stay ?? rooms[0]?.id;
    if (next !== roomId) {
      roomId = next;
      selected = undefined;
    }
  } else if (!roomId || !state.rooms.has(roomId)) {
    roomId = rooms[0]?.id;
  }
  scene.setRoom(roomId);
  if (selected && !selected.startsWith("p:") && !state.hasSelection(selected)) selected = undefined;
  scene.selected = selected && (selected.startsWith("p:") || state.agents.has(selected)) ? selected : undefined;
}

setInterval(() => {
  if (!dirty && rendered === state.version) return;
  chooseRoom();
  scene.syncNow();
  panel.render(roomId, selected);
  attention.render();
  if (timelineToggle.checked) timeline.render(roomId, selected);
  rendered = state.version;
  dirty = false;
}, 250);
// refresh relative times, breakroom activities and the timeline's "now"
setInterval(() => (dirty = true), 2000);

let streamed = false;

function connect() {
  // quick first paint from a plain request; the stream sends its own snapshot when it connects
  fetch("api/state")
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((snap: Snapshot) => {
      if (streamed) return;
      state.load(snap);
      scene.reset();
      dirty = true;
    })
    .catch(() => {});
  const es = new EventSource("api/events");
  es.addEventListener("snapshot", (e) => {
    void controls.refresh();
    streamed = true;
    state.load(JSON.parse((e as MessageEvent).data) as Snapshot);
    state.setConnected(true);
    scene.reset();
    conn.className = "conn ok";
    conn.title = "connected";
    dirty = true;
  });
  es.addEventListener("ops", (e) => state.apply(JSON.parse((e as MessageEvent).data) as Op[]));
  es.onerror = () => {
    state.setConnected(false);
    dirty = true;
    conn.className = "conn bad";
    conn.title = "disconnected – reconnecting…";
  };
}

connect();
