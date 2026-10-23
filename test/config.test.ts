import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("config precedence: env > plugin options > pixel-office.json > defaults", () => {
  assert.deepEqual(loadConfig({}, {}, {}), { port: 4777, host: "127.0.0.1", token: undefined });
  assert.deepEqual(loadConfig({}, {}, { port: 5000, host: "0.0.0.0", token: "file" }), { port: 5000, host: "0.0.0.0", token: "file" });
  assert.deepEqual(loadConfig({ port: 6000, token: "opt" }, {}, { port: 5000, host: "0.0.0.0", token: "file" }), { port: 6000, host: "0.0.0.0", token: "opt" });
  assert.deepEqual(loadConfig({ port: 6000 }, { PIXEL_OFFICE_PORT: "7000", PIXEL_OFFICE_TOKEN: "env" }, { token: "file" }), { port: 7000, host: "127.0.0.1", token: "env" });
  assert.equal(loadConfig({}, { PIXEL_OFFICE_PORT: "99999" }, {}).port, 4777);
});
