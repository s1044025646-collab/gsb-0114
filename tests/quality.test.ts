import { describe, it, expect } from "vitest";
import { freshCtx, seedMaster, measure, T0 } from "./helpers";
describe("quality tracking", () => {
  it("judges measurements and is idempotent on measurementId", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    const m = measure("m1", "WP-1", 10.005, T0 + 1000);
    const r1 = ctx.svc.quality.recordMeasurement(m);
    expect(r1.stored).toBe(true);
    expect(r1.judgement!.result).toBe("pass");
    const r2 = ctx.svc.quality.recordMeasurement(m);
    expect(r2.stored).toBe(false);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM measurements").get() as any).toEqual({ n: 1 });
  });
  it("raises a drift alert on slow drift toward the limit", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    [10.015, 10.016, 10.017].forEach((v, i) =>
      ctx.svc.quality.recordMeasurement(measure(`d${i}`, `WP-${i}`, v, T0 + i * 1000))
    );
    const alerts = ctx.db.prepare("SELECT * FROM alerts WHERE type = 'drift'").all();
    expect(alerts.length).toBe(1);
  });
  it("traces suspects after a sudden break, splitting reject vs recheck", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.quality.recordMeasurement(measure("m1", "WP-1", 10.0, T0 + 1000)); // last good
    ctx.svc.quality.recordMeasurement(measure("m2", "WP-2", 10.005, T0 + 2000)); // in tol -> recheck
    ctx.svc.quality.recordMeasurement(measure("m3", "WP-3", 10.08, T0 + 3000)); // fail -> reject
    const batches = ctx.db.prepare("SELECT * FROM suspect_batches").all() as any[];
    expect(batches).toHaveLength(1);
    const items = ctx.db.prepare("SELECT * FROM suspect_items ORDER BY workpiece_sn").all() as any[];
    const bySn = Object.fromEntries(items.map((i) => [i.workpiece_sn, i.classification]));
    expect(bySn["WP-1"]).toBeUndefined(); // before the last known-good check
    expect(bySn["WP-2"]).toBe("recheck"); // in tolerance but produced since last good
    expect(bySn["WP-3"]).toBe("reject"); // measured out of tolerance
  });
  it("alerts when the gauge calibration is expired at measurement time", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    const late = T0 + 40 * 86400_000; // past the 30-day interval
    ctx.svc.quality.recordMeasurement(measure("m1", "WP-1", 10.0, late));
    const alerts = ctx.db.prepare("SELECT * FROM alerts WHERE type = 'gauge_expired'").all();
    expect(alerts.length).toBe(1);
  });
  it("re-evaluates after a calibration correction and preserves old judgements", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    const late = T0 + 40 * 86400_000;
    ctx.svc.quality.recordMeasurement(measure("m1", "WP-1", 10.0, late));
    let j = ctx.db.prepare("SELECT * FROM judgements WHERE superseded_at IS NULL").all() as any[];
    expect(j[0].reason).toContain("expired");
    // correction: the gauge was actually calibrated at T0+35d (backdated)
    const res = ctx.svc.quality.correctCalibration("GAUGE-1", T0 + 35 * 86400_000, 30, "found cert");
    expect(res.reevaluated).toBe(1);
    const all = ctx.db.prepare("SELECT * FROM judgements ORDER BY id").all() as any[];
    expect(all).toHaveLength(2); // old judgement preserved
    expect(all[0].superseded_at).not.toBeNull();
    expect(all[1].reason).not.toContain("expired");
  });
  it("re-evaluates all judgements when the scrap threshold changes", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.quality.recordMeasurement(measure("m1", "WP-1", 10.005, T0 + 1000));
    const res = ctx.svc.quality.setScrapThreshold(1.5);
    expect(res.reevaluated).toBe(1);
    const all = ctx.db.prepare("SELECT * FROM judgements").all() as any[];
    expect(all).toHaveLength(2);
    expect(all.filter((j) => j.superseded_at === null)).toHaveLength(1);
  });
  it("records scrap/rework idempotently", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    expect(ctx.svc.quality.recordQualityAction("a1", "WO-1", "WP-1", "scrap", "bad").stored).toBe(true);
    expect(ctx.svc.quality.recordQualityAction("a1", "WO-1", "WP-1", "scrap", "bad").stored).toBe(false);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM quality_actions").get()).toEqual({ n: 1 });
  });
  it("produces a traceability report covering segments, measurements and actions", () => {
    const ctx = freshCtx();
    seedMaster(ctx);
    ctx.svc.events.installEdge("TOOL-001", 1, "MC-01", T0);
    ctx.svc.events.ingestBatch([
      { eventId: "s", machineCode: "MC-01", type: "cutting_start", ts: T0 + 1, payload: { workorder: "WO-1" } },
      { eventId: "e", machineCode: "MC-01", type: "cutting_stop", ts: T0 + 60_000 },
    ]);
    ctx.svc.quality.recordMeasurement(measure("m1", "WP-1", 10.0, T0 + 61_000));
    ctx.svc.quality.recordQualityAction("a1", "WO-1", "WP-1", "rework", "minor");
    const report = ctx.svc.quality.traceabilityReport("WO-1");
    expect(report.workorder.code).toBe("WO-1");
    expect(report.cuttingSegments).toHaveLength(1);
    expect(report.measurements).toHaveLength(1);
    expect(report.qualityActions).toHaveLength(1);
  });
});
