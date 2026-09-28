import { describe, it, expect } from "vitest";
import { freshCtx, seedMaster, tmpDbPath, T0 } from "./helpers";
import { openDb } from "../src/db";
import { FixedClock } from "../src/clock";
import { makeServices } from "../src/app";
describe("edge occupancy", () => {
  it("rejects installing one edge on two machines at once", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    expect(() => ctx.svc.events.installEdge("TOOL-001", 1, "MC-02", T0 + 1)).toThrowError(
      /already installed/
    );
    const active = ctx.db
      .prepare("SELECT * FROM installations WHERE removed_at IS NULL")
      .all() as any[];
    expect(active).toHaveLength(1);
  });
  it("enforces the unique active-install index across separate connections", () => {
    const dbPath = tmpDbPath();
    const a = freshCtx(dbPath);
    seedMaster(a);
    const dbB = openDb(dbPath);
    const svcB = makeServices(dbB, new FixedClock(T0));
    a.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    expect(() => svcB.events.installEdge("TOOL-001", 1, "MC-02", T0)).toThrowError();
    dbB.close();
    a.db.close();
  });
  it("allows reinstall after removal", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    ctx.svc.events.removeEdge("TOOL-001", 1, T0 + 1000);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-02", T0 + 2000);
    const active = ctx.db
      .prepare("SELECT * FROM installations WHERE removed_at IS NULL")
      .all() as any[];
    expect(active).toHaveLength(1);
  });
  it("rejects removing an edge that is not installed", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    expect(() => ctx.svc.events.removeEdge("TOOL-001", 2, T0)).toThrowError(/not installed/);
  });
});
