import { DB } from "../db";
import { Clock } from "../clock";
import { AppError, notFound, conflict } from "../errors";

export class CoreService {
  constructor(private db: DB, private clock: Clock) {}

  createMachine(code: string, name: string) {
    try {
      const r = this.db
        .prepare("INSERT INTO machines (code, name, created_at) VALUES (?, ?, ?)")
        .run(code, name, this.clock.now());
      return this.getMachine(code);
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) throw conflict(`machine ${code} already exists`);
      throw e;
    }
  }

  getMachine(code: string) {
    const m = this.db.prepare("SELECT * FROM machines WHERE code = ?").get(code);
    if (!m) throw notFound(`machine ${code}`);
    return m as any;
  }

  createTool(serial: string, name: string, edgeCount: number, lifeLimitSec: number) {
    const tx = this.db.transaction(() => {
      try {
        const r = this.db
          .prepare("INSERT INTO tools (serial, name, created_at) VALUES (?, ?, ?)")
          .run(serial, name, this.clock.now());
        const toolId = Number(r.lastInsertRowid);
        const ins = this.db.prepare(
          "INSERT INTO tool_edges (tool_id, edge_no, life_limit_sec) VALUES (?, ?, ?)"
        );
        for (let i = 1; i <= edgeCount; i++) ins.run(toolId, i, lifeLimitSec);
        return toolId;
      } catch (e: any) {
        if (String(e.message).includes("UNIQUE")) throw conflict(`tool ${serial} already exists`);
        throw e;
      }
    });
    const id = tx();
    return this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as any;
  }

  getTool(serial: string) {
    const t = this.db.prepare("SELECT * FROM tools WHERE serial = ?").get(serial);
    if (!t) throw notFound(`tool ${serial}`);
    return t as any;
  }

  listEdges(toolSerial: string) {
    const tool = this.getTool(toolSerial);
    return this.db
      .prepare(
        `SELECT te.*, i.machine_id, i.installed_at, i.removed_at
         FROM tool_edges te
         LEFT JOIN installations i ON i.edge_id = te.id AND i.removed_at IS NULL
         WHERE te.tool_id = ? ORDER BY te.edge_no`
      )
      .all(tool.id) as any[];
  }

  registerProgram(code: string, version: string) {
    const existing = this.db
      .prepare("SELECT * FROM programs WHERE code = ? AND version = ?")
      .get(code, version) as any;
    if (existing) return existing;
    const r = this.db
      .prepare("INSERT INTO programs (code, version, created_at) VALUES (?, ?, ?)")
      .run(code, version, this.clock.now());
    return this.db.prepare("SELECT * FROM programs WHERE id = ?").get(Number(r.lastInsertRowid)) as any;
  }

  createWorkorder(code: string, partNo: string, programCode: string, programVersion: string, qtyTarget: number) {
    const program = this.registerProgram(programCode, programVersion);
    try {
      const r = this.db
        .prepare(
          "INSERT INTO workorders (code, part_no, program_id, qty_target, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(code, partNo, program.id, qtyTarget, this.clock.now());
      return this.getWorkorder(code);
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) throw conflict(`workorder ${code} already exists`);
      throw e;
    }
  }

  getWorkorder(code: string) {
    const w = this.db
      .prepare(
        `SELECT w.*, p.code AS program_code, p.version AS program_version
         FROM workorders w JOIN programs p ON p.id = w.program_id WHERE w.code = ?`
      )
      .get(code);
    if (!w) throw notFound(`workorder ${code}`);
    return w as any;
  }

  createGauge(code: string, calIntervalDays: number, calibratedAt?: number) {
    const tx = this.db.transaction(() => {
      try {
        const r = this.db
          .prepare("INSERT INTO gauges (code, cal_interval_days, created_at) VALUES (?, ?, ?)")
          .run(code, calIntervalDays, this.clock.now());
        const gaugeId = Number(r.lastInsertRowid);
        this.db
          .prepare(
            "INSERT INTO gauge_calibrations (gauge_id, calibrated_at, interval_days, note, recorded_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run(gaugeId, calibratedAt ?? this.clock.now(), calIntervalDays, "initial", this.clock.now());
        return gaugeId;
      } catch (e: any) {
        if (String(e.message).includes("UNIQUE")) throw conflict(`gauge ${code} already exists`);
        throw e;
      }
    });
    const id = tx();
    return this.db.prepare("SELECT * FROM gauges WHERE id = ?").get(id) as any;
  }

  getGauge(code: string) {
    const g = this.db.prepare("SELECT * FROM gauges WHERE code = ?").get(code);
    if (!g) throw notFound(`gauge ${code}`);
    return g as any;
  }

  /** Append a calibration record (also used for corrections). Never overwrites history. */
  addCalibration(gaugeCode: string, calibratedAt: number, intervalDays: number, note = "") {
    const gauge = this.getGauge(gaugeCode);
    this.db
      .prepare(
        "INSERT INTO gauge_calibrations (gauge_id, calibrated_at, interval_days, note, recorded_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(gauge.id, calibratedAt, intervalDays, note, this.clock.now());
    return this.gaugeStatus(gaugeCode);
  }

  /** Effective calibration as of `ts` (uses the latest record with recorded_at ordering). */
  calibrationAt(gaugeId: number, ts: number) {
    return this.db
      .prepare(
        `SELECT * FROM gauge_calibrations WHERE gauge_id = ? AND calibrated_at <= ?
         ORDER BY calibrated_at DESC, id DESC LIMIT 1`
      )
      .get(gaugeId, ts) as any | undefined;
  }

  gaugeStatus(code: string) {
    const gauge = this.getGauge(code);
    const now = this.clock.now();
    const cal = this.calibrationAt(gauge.id, now);
    const expiresAt = cal ? cal.calibrated_at + cal.interval_days * 86400_000 : null;
    return {
      ...gauge,
      last_calibration: cal ?? null,
      expires_at: expiresAt,
      expired: expiresAt === null || expiresAt < now,
    };
  }
}
