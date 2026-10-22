import type { Op, Snapshot } from "../src/types.ts";
import { Panel } from "./panel.ts";
import { Scene } from "./scene.ts";
import { ClientState } from "./state.ts";

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

const state = new ClientState();
const scene = new Scene(document.getElementById("office") as HTMLCanvasElement, state);
const follow = document.getElementById("follow") as HTMLInputElement;
const showAll = document.getElementById("show-all") as HTMLInputElement;
const conn = document.getElementById("conn")!;

let roomId = store.get("room");
let selected: string | undefined;
let rendered = -1;
let dirty = true;

follow.checked = store.get("follow") !== "0";
follow.onchange = () => {
  store.set("follow", follow.checked ? "1" : "0");
  dirty = true;
};
showAll.onchange = () => (dirty = true);

const panel = new Panel(state, {
  selectRoom(id) {
    roomId = id;
    store.set("room", id);
    follow.checked = false;
    store.set("follow", "0");
    selected = undefined;
    dirty = true;
  },
  selectAgent(id) {
    selected = id;
    dirty = true;
  },
});

scene.onSelect = (id) => {
  selected = id;
  dirty = true;
};

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
  if (selected && !state.agents.has(selected)) selected = undefined;
  scene.selected = selected;
}

setInterval(() => {
  if (!dirty && rendered === state.version) return;
  chooseRoom();
  panel.render(roomId, selected);
  rendered = state.version;
  dirty = false;
}, 250);
// refresh relative times
setInterval(() => (dirty = true), 5000);

function connect() {
  const es = new EventSource("api/events");
  es.addEventListener("snapshot", (e) => {
    state.load(JSON.parse((e as MessageEvent).data) as Snapshot);
    scene.reset();
    conn.className = "conn ok";
    conn.title = "verbunden";
    dirty = true;
  });
  es.addEventListener("ops", (e) => state.apply(JSON.parse((e as MessageEvent).data) as Op[]));
  es.onerror = () => {
    conn.className = "conn bad";
    conn.title = "getrennt – verbinde neu…";
  };
}

connect();
