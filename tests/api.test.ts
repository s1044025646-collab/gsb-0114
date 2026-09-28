import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app";
import { FixedClock } from "../src/clock";
import { freshCtx, seedMaster, T0 } from "./helpers";
import type { Server } from "http";
let server: Server;
let base: string;
const ctx = freshCtx();
beforeAll(async () => {
  seedMaster(ctx);
  const app = createApp(ctx.db, ctx.clock);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
describe("API", () => {
  it("validates parameters and returns a stable error code", async () => {
    const res = await post("/workorders", { code: "X" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
  it("returns 404 NOT_FOUND for unknown entities", async () => {
    const res = await fetch(`${base}/workorders/NOPE`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
  it("rejects double-install with EDGE_IN_USE", async () => {
    await post("/tool-changes/install", { toolSerial: "TOOL-001", edgeNo: 1, machineCode: "MC-01", ts: T0 });
    const res = await post("/tool-changes/install", { toolSerial: "TOOL-001", edgeNo: 1, machineCode: "MC-02", ts: T0 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("EDGE_IN_USE");
  });
  it("ingests events idempotently via the API", async () => {
    const ev = { eventId: "api-e1", machineCode: "MC-01", type: "cutting_start", ts: T0 + 5000, payload: { workorder: "WO-1" } };
    const r1 = await (await post("/events", ev)).json();
    const r2 = await (await post("/events", ev)).json();
    expect(r1.stored).toBe(true);
    expect(r2.stored).toBe(false);
  });
  it("paginates list endpoints", async () => {
    for (let i = 0; i < 5; i++) {
      await post("/measurements", {
        measurementId: `pg-${i}`,
        workorderCode: "WO-1",
        workpieceSn: `WP-${i}`,
        feature: "diameter",
        value: 10,
        nominal: 10,
        tolPlus: 0.02,
        tolMinus: 0.02,
        gaugeCode: "GAUGE-1",
        measuredAt: T0 + i,
      });
    }
    const res = await fetch(`${base}/measurements?workorder=WO-1&limit=2&offset=2`);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.page.total).toBe(5);
    expect(body.page.limit).toBe(2);
  });
  it("rejects malformed JSON with VALIDATION_ERROR", async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
