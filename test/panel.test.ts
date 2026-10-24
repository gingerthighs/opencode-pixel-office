import { test } from "node:test";
import assert from "node:assert/strict";
import { Panel } from "../web/panel.ts";
import { ClientState } from "../web/state.ts";
import { Store } from "../src/store.ts";
import type { ControlRequest } from "../src/types.ts";

import { installDOM } from "./dom.ts";

test("approval buttons follow request/session identity while unchanged buttons retain DOM identity", async (t) => {
  const elements = installDOM(t);
  const store = new Store();
  for (const id of ["a", "b"]) store.apply({ type: "session.created", properties: { info: { id } } });
  const state = new ClientState();
  const requests: ControlRequest[] = [];
  const panel = new Panel(state, {
    selectRoom: () => {}, select: () => {}, control: async (req) => { requests.push(req); },
    caps: () => ({ control: true }), workerName: () => undefined, personInfo: () => undefined, roster: () => [],
  });
  function render(sessionID: string, requestID: string) {
    store.apply({ type: "permission.asked", properties: { sessionID, id: requestID, permission: "bash", patterns: ["npm test"] } });
    state.load(store.snapshot()); panel.render(sessionID, sessionID);
    return elements.get("detail")!.find("Allow once")!;
  }
  const first = render("a", "request-1");
  assert.ok(first);
  assert.equal(render("a", "request-1"), first, "unchanged polling preserves clickable node");
  const second = render("a", "request-2");
  assert.notEqual(second, first, "new request refreshes captured ID despite identical visible text");
  second.onclick!(); await Promise.resolve();
  assert.deepEqual(requests[0], { action: "permission", sessionID: "a", requestID: "request-2", decision: "once" });
  // Switch sessions before feedback is rendered; identical request IDs must not reuse handlers.
  const third = render("b", "request-2"); third.onclick!(); await Promise.resolve();
  assert.deepEqual(requests[1], { action: "permission", sessionID: "b", requestID: "request-2", decision: "once" });
});
