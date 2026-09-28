import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openDb, DB } from "../src/db";
import { FixedClock } from "../src/clock";
import { makeServices, Services } from "../src/app";
export const T0 = 1_700_000_000_000;
export interface Ctx {
  db: DB;
  clock: FixedClock;
  svc: Services;
  dbPath: string;
}
export function freshCtx(dbPath = ":memory:"): Ctx {
  const clock = new FixedClock(T0);
  const db = openDb(dbPath);
  const svc = makeServices(db, clock);
  return { db, clock, svc, dbPath };
}
export function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cnc-test-")), "test.db");
}
/** Standard fictional master data: 2 machines, 1 tool (2 edges, 600s), gauge, workorder. */
export function seedMaster(ctx: Ctx) {
  const { svc } = ctx;
  svc.core.createMachine("MC-01", "Mill 1");
  svc.core.createMachine("MC-02", "Mill 2");
  svc.core.createTool("TOOL-001", "EndMill", 2, 600);
  svc.core.createGauge("GAUGE-1", 30, T0);
  svc.core.createWorkorder("WO-1", "PART-1", "PROG-A", "v1", 100);
}
export function cut(machineCode: string, eventId: string, startTs: number, seconds: number) {
  return [
    {
      eventId: `${eventId}-s`,
      machineCode,
      type: "cutting_start" as const,
      ts: startTs,
      payload: { workorder: "WO-1" },
    },
    {
      eventId: `${eventId}-e`,
      machineCode,
      type: "cutting_stop" as const,
      ts: startTs + seconds * 1000,
    },
  ];
}
export function measure(id: string, sn: string, value: number, measuredAt: number, gauge = "GAUGE-1") {
  return {
    measurementId: id,
    workorderCode: "WO-1",
    workpieceSn: sn,
    feature: "diameter",
    value,
    nominal: 10,
    tolPlus: 0.02,
    tolMinus: 0.02,
    gaugeCode: gauge,
    measuredAt,
  };
}
