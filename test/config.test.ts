import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const defaults = { port: 4777, host: "127.0.0.1", token: undefined, allowedHosts: [], debug: false };

test("config precedence: env > plugin options > pixel-office.json > defaults", () => {
  assert.deepEqual(loadConfig({}, {}, {}), defaults);
  assert.deepEqual(loadConfig({}, {}, { port: 5000, host: "0.0.0.0", token: "file" }), { ...defaults, port: 5000, host: "0.0.0.0", token: "file" });
  assert.deepEqual(loadConfig({ port: 6000, token: "opt" }, {}, { port: 5000, host: "0.0.0.0", token: "file" }), {
    ...defaults,
    port: 6000,
    host: "0.0.0.0",
    token: "opt",
  });
  assert.deepEqual(loadConfig({ port: 6000 }, { PIXEL_OFFICE_PORT: "7000", PIXEL_OFFICE_TOKEN: "env" }, { token: "file" }), {
    ...defaults,
    port: 7000,
    token: "env",
  });
  assert.equal(loadConfig({}, { PIXEL_OFFICE_PORT: "99999" }, {}).port, 4777);
});

test("allowedHosts and debug accept lists, strings and flags", () => {
  assert.deepEqual(loadConfig({}, { PIXEL_OFFICE_ALLOWED_HOSTS: "box.tail1.ts.net, nas.local" }, {}).allowedHosts, ["box.tail1.ts.net", "nas.local"]);
  assert.deepEqual(loadConfig({}, {}, { allowedHosts: ["a.example"] }).allowedHosts, ["a.example"]);
  assert.equal(loadConfig({}, { PIXEL_OFFICE_DEBUG: "1" }, {}).debug, true);
  assert.equal(loadConfig({}, { PIXEL_OFFICE_DEBUG: "0" }, { debug: true }).debug, false);
  assert.equal(loadConfig({}, {}, { debug: true }).debug, true);
});
