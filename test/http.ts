import { request } from "node:http";
import type { ControlRequest } from "../src/types.ts";

export function http(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("test HTTP request timed out")));
    req.on("error", reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

export async function control(port: number, body: ControlRequest, token?: string) {
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const caps = JSON.parse((await http(port, "/api/caps", { headers: auth })).body);
  return http(port, "/api/control", { method: "POST", headers: { ...auth, "x-po-nonce": caps.nonce, "content-type": "application/json" }, body });
}
