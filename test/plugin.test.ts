import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../src/plugin.ts";
import { Hub } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { control } from "./http.ts";

async function config(t: TestContext) {
  const probe = new Hub(new Store(), { port: 0, host: "127.0.0.1", html: "", js: "" });
  await probe.listen(); const port = probe.port; await probe.close();
  const names = ["PIXEL_OFFICE_PORT", "PIXEL_OFFICE_HOST", "PIXEL_OFFICE_TOKEN", "PIXEL_OFFICE_DEBUG"];
  const before = names.map((key) => process.env[key]);
  for (const key of names) delete process.env[key];
  t.after(() => names.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }));
  return { port, host: "127.0.0.1", token: "regression-token", debug: false };
}

test("v1 SDK HTTP errors reach the UI for both interrupt and permission replies", async (t) => {
  const options = await config(t);
  let failed = true;
  const requests: string[] = [];
  const client = createOpencodeClient({ baseUrl: "http://sdk.test", fetch: async (req: Request) => {
    requests.push(req.url);
    const isControl = /\/abort$|\/permissions\//.test(req.url);
    const status = isControl && failed ? 404 : 200;
    const data = status === 404 ? { name: "NotFoundError", data: { message: "session missing" } }
      : req.url.endsWith("/session") ? [] : {};
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  } });
  const hooks = await plugin.server({ client } as never, options);
  t.after(() => hooks.dispose?.());
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: "s" } } } as never });
  const interrupt = { action: "interrupt", sessionID: "s" } as const;
  const permission = { action: "permission", sessionID: "s", requestID: "req", decision: "reject" } as const;
  assert.equal((await control(options.port, interrupt, options.token)).status, 502);
  assert.equal((await control(options.port, permission, options.token)).status, 502);
  assert.ok(requests.some((url) => url.endsWith("/session/s/abort")));
  assert.ok(requests.some((url) => url.includes("/permissions/req")));
  failed = false;
  assert.equal((await control(options.port, interrupt, options.token)).status, 200);
  assert.equal((await control(options.port, permission, options.token)).status, 200);
});

test("v1 error envelopes cannot report success even if the API ignores throwOnError", async (t) => {
  const options = await config(t);
  const client = {
    app: { log: async () => {} },
    session: { list: async () => [], status: async () => ({}), abort: async () => ({ error: "cannot abort" }) },
    permission: { reply: async () => ({ error: "cannot approve" }) },
  };
  const hooks = await plugin.server({ client } as never, options);
  t.after(() => hooks.dispose?.());
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: "s" } } } as never });
  const response = await control(options.port, { action: "interrupt", sessionID: "s" }, options.token);
  assert.equal(response.status, 502); assert.match(response.body, /cannot abort/);
  const approval = await control(options.port, { action: "permission", sessionID: "s", requestID: "req", decision: "once" }, options.token);
  assert.equal(approval.status, 502); assert.match(approval.body, /cannot approve/);
});

test("v2 seeded sessions retain their own controller and surface returned errors", async (t) => {
  const options = await config(t);
  function context(id: string) {
    return {
      options,
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
      session: {
        list: async () => [{ id, time: { created: Date.now() } }],
        interrupt: async () => ({ error: `interrupt ${id}` }),
      },
      permission: { reply: async () => ({ error: `permission ${id}` }) },
    };
  }
  const disposeA = await plugin.setup(context("a")); t.after(disposeA);
  const disposeB = await plugin.setup(context("b")); t.after(disposeB);
  const response = await control(options.port, { action: "interrupt", sessionID: "a" }, options.token);
  assert.equal(response.status, 502); assert.match(response.body, /interrupt a/);
  const reply = await control(options.port, { action: "permission", sessionID: "b", requestID: "req", decision: "once" }, options.token);
  assert.equal(reply.status, 502); assert.match(reply.body, /permission b/);
});
