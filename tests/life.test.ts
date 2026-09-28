import { describe, it, expect } from "vitest";
import { freshCtx, seedMaster, cut, tmpDbPath, T0 } from "./helpers";
import { openDb } from "../src/db";
import { FixedClock } from "../src/clock";
import { makeServices } from "../src/app";
describe("tool life accumulation", () => {
  it("attributes cutting time to the installed edge and program version", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    ctx.svc.events.ingestBatch(cut("MC-01", "e1", T0 + 1000, 100));
    const life = ctx.svc.events.toolLife("TOOL-001");
    expect(life.edges[0].usedSec).toBe(100);
    expect(life.edges[0].remainingSec).toBe(500);
    expect(life.edges[1].usedSec).toBe(0);
    const seg = ctx.db.prepare("SELECT * FROM cutting_segments").all() as any[];
    expect(seg).toHaveLength(1);
    const prog = ctx.db.prepare("SELECT program_id FROM cutting_segments").get() as any;
    expect(prog.program_id).toBeGreaterThan(0);
  });
  it("does not double-count duplicate events", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    const events = [...cut("MC-01", "e1", T0 + 1000, 100), ...cut("MC-01", "e1", T0 + 1000, 100)];
    const res = ctx.svc.events.ingestBatch(events);
    expect(res.duplicates).toBe(2);
    expect(ctx.svc.events.toolLife("TOOL-001").edges[0].usedSec).toBe(100);
  });
  it("handles out-of-order delivery", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    const [start, stop] = cut("MC-01", "e1", T0 + 1000, 100);
    ctx.svc.events.ingest(stop);
    ctx.svc.events.ingest(start);
    expect(ctx.svc.events.toolLife("TOOL-001").edges[0].usedSec).toBe(100);
  });
  it("ignores segments with skewed (non-positive) clock durations", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    ctx.svc.events.ingestBatch(cut("MC-01", "skew", T0 + 1000, -50));
    expect(ctx.svc.events.toolLife("TOOL-001").edges[0].usedSec).toBe(0);
  });
  it("clamps a cut that overlaps a tool change at the removal time", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    ctx.svc.events.ingest({
      eventId: "s1",
      machineCode: "MC-01",
      type: "cutting_start",
      ts: T0 + 1000,
      payload: { workorder: "WO-1" },
    });
    ctx.svc.events.removeEdge("TOOL-001", 1, T0 + 61_000);
    ctx.svc.events.installEdge("TOOL-001", 2, "MC-01", T0 + 61_000);
    ctx.svc.events.ingest({ eventId: "x1", machineCode: "MC-01", type: "cutting_stop", ts: T0 + 101_000 });
    const life = ctx.svc.events.toolLife("TOOL-001");
    expect(life.edges[0].usedSec).toBe(60);
    expect(life.edges[1].usedSec).toBe(0);
  });
  it("persists accumulated life across process restart", () => {
    const dbPath = tmpDbPath();
    {
      const ctx = freshCtx(dbPath);
      seedMaster(ctx);
      ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
      ctx.svc.events.ingestBatch(cut("MC-01", "e1", T0 + 1000, 100));
      ctx.db.close();
    }
    {
      const db = openDb(dbPath);
      const svc = makeServices(db, new FixedClock(T0 + 200_000));
      expect(svc.events.toolLife("TOOL-001").edges[0].usedSec).toBe(100);
      const res = svc.events.ingestBatch(cut("MC-01", "e1", T0 + 1000, 100));
      expect(res.duplicates).toBe(2);
      expect(svc.events.toolLife("TOOL-001").edges[0].usedSec).toBe(100);
      db.close();
    }
  });
});
