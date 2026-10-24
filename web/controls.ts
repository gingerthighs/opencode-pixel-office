import type { ControlRequest } from "../src/types.ts";

export interface Capabilities {
  control: boolean;
  reason?: string;
  nonce?: string;
}

/** Credentials belong to the current hub, which may change while SSE reconnects. */
export class Controls {
  caps: Capabilities = { control: false, reason: "loading…" };
  private generation = 0;
  private fetcher: typeof fetch;
  private changed: () => void;

  constructor(fetcher: typeof fetch = fetch, changed: () => void = () => {}) {
    // Native browser fetch rejects a Controls instance as its receiver.
    this.fetcher = (...args) => fetcher(...args);
    this.changed = changed;
  }

  async refresh(): Promise<Capabilities> {
    const generation = ++this.generation;
    let caps: Capabilities;
    try {
      const res = await this.fetcher("api/caps", { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      caps = await res.json();
      if (typeof caps.control !== "boolean" || (caps.control && typeof caps.nonce !== "string")) {
        throw new Error("invalid capabilities");
      }
    } catch {
      caps = { control: false, reason: "unreachable" };
    }
    if (generation === this.generation) {
      this.caps = caps;
      this.changed();
    }
    return caps;
  }

  async send(req: ControlRequest) {
    // Also refresh at click time, covering clicks before the SSE reconnect arrives.
    const caps = await this.refresh();
    if (!caps.control) throw new Error(caps.reason ?? "controls unavailable");
    const res = await this.fetcher("api/control", {
      method: "POST",
      headers: { "content-type": "application/json", "x-po-nonce": caps.nonce! },
      body: JSON.stringify(req),
    });
    // Never replay a control: a lost response does not imply it was not executed.
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
  }
}
