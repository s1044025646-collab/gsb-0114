import { DB } from "../db";
import { Clock } from "../clock";
import { AppError, notFound } from "../errors";
import { CoreService } from "./core";
import { EventService } from "./events";

export interface MeasurementInput {
  measurementId: string;
  workorderCode: string;
  workpieceSn: string;
  feature: string;
  value: number;
  nominal: number;
  tolPlus: number;
  tolMinus: number;
  gaugeCode: string;
  measuredAt: number;
}

const DRIFT_WINDOW = 3;
const DRIFT_RATIO = 0.7;
const RULE = "tolerance-v2";

export class QualityService {
  constructor(
    private db: DB,
    private clock: Clock,
    private core: CoreService,
    private events: EventService
  ) {}

  get scrapOverTolRatio(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'scrap_over_tol_ratio'").get() as any;
    return row ? Number(row.value) : 1.0;
  }

  /**
   * Change the scrap threshold and re-evaluate all existing judgements.
   * Old judgements are superseded, never deleted.
   */
  setScrapThreshold(ratio: number): { reevaluated: number } {
    if (!(ratio > 0)) throw new AppError("VALIDATION_ERROR", "ratio must be > 0", 422);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('scrap_over_tol_ratio', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(String(ratio), this.clock.now());
      return this.reevaluateAll();
    });
    return { reevaluated: tx() };
  }

  /** Record a raw measurement (append-only, idempotent) and judge it. */
  recordMeasurement(input: MeasurementInput): { stored: boolean; judgement?: any } {
    const tx = this.db.transaction(() => {
      const dup = this.db
        .prepare("SELECT id FROM measurements WHERE measurement_id = ?")
        .get(input.measurementId);
      if (dup) return { stored: false };
      const wo = this.db.prepare("SELECT * FROM workorders WHERE code = ?").get(input.workorderCode) as any;
      if (!wo) throw notFound(`workorder ${input.workorderCode}`);
      if (wo.status === "closed") throw new AppError("WORKORDER_CLOSED", "workorder is closed", 409);
      const gauge = this.db.prepare("SELECT * FROM gauges WHERE code = ?").get(input.gaugeCode) as any;
      if (!gauge) throw notFound(`gauge ${input.gaugeCode}`);

      const r = this.db
        .prepare(
          `INSERT INTO measurements
             (measurement_id, workorder_id, workpiece_sn, feature, value, nominal, tol_plus, tol_minus, gauge_id, measured_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.measurementId,
          wo.id,
          input.workpieceSn,
          input.feature,
          input.value,
          input.nominal,
          input.tolPlus,
          input.tolMinus,
          gauge.id,
          input.measuredAt,
          this.clock.now()
        );
      const measurementPk = Number(r.lastInsertRowid);

      const cal = this.core.calibrationAt(gauge.id, input.measuredAt);
      const gaugeExpired =
        !cal || cal.calibrated_at + cal.interval_days * 86400_000 < input.measuredAt;
      if (gaugeExpired) {
        this.events.raiseAlert(
          "gauge_expired",
          `gauge ${input.gaugeCode} calibration expired at measurement ${input.measurementId}`,
          { gaugeCode: input.gaugeCode, measurementId: input.measurementId }
        );
      }

      const judgement = this.judge(measurementPk, gaugeExpired);
      this.checkDrift(wo.id, input.feature);
      if (judgement.result === "fail") this.traceSuspects(measurementPk);
      return { stored: true, judgement };
    });
    return tx();
  }

  private judge(measurementPk: number, gaugeExpired = false) {
    const m = this.db.prepare("SELECT * FROM measurements WHERE id = ?").get(measurementPk) as any;
    const offset = m.value - m.nominal;
    const inTol = offset <= m.tol_plus && offset >= -m.tol_minus;
    const result = inTol ? "pass" : "fail";
    const reasons: string[] = [];
    if (!inTol) reasons.push(`offset ${offset.toFixed(4)} outside [-${m.tol_minus}, +${m.tol_plus}]`);
    if (gaugeExpired) reasons.push("gauge calibration expired");
    this.db
      .prepare("INSERT INTO judgements (measurement_id, result, reason, rule, judged_at) VALUES (?, ?, ?, ?, ?)")
      .run(measurementPk, result, reasons.join("; "), RULE, this.clock.now());
    return { measurementPk, result, offset, reason: reasons.join("; ") };
  }

  /** Slow drift detection: last N offsets same sign and beyond DRIFT_RATIO of tolerance. */
  private checkDrift(workorderId: number, feature: string) {
    const rows = this.db
      .prepare(
        `SELECT value, nominal, tol_plus, tol_minus FROM measurements
         WHERE workorder_id = ? AND feature = ?
         ORDER BY measured_at DESC, id DESC LIMIT ?`
      )
      .all(workorderId, feature, DRIFT_WINDOW) as any[];
    if (rows.length < DRIFT_WINDOW) return;
    const ratios = rows.map((r) => {
      const offset = r.value - r.nominal;
      const tol = offset >= 0 ? r.tol_plus : r.tol_minus;
      return tol > 0 ? offset / tol : 0;
    });
    const drifting =
      ratios.every((x) => x > DRIFT_RATIO) || ratios.every((x) => x < -DRIFT_RATIO);
    if (drifting) {
      const wo = this.db.prepare("SELECT code FROM workorders WHERE id = ?").get(workorderId) as any;
      this.events.raiseAlert(
        "drift",
        `feature '${feature}' on workorder ${wo.code} drifting toward tolerance limit`,
        { workorder: wo.code, feature, ratios }
      );
    }
  }

  /**
   * On a failed measurement, trace workpieces measured since the last pass
   * for the same workorder+feature. The failed workpiece (and any other
   * failing one) is 'reject'; pieces that passed in between only need
   * 'recheck' because the failure may have started after them.
   */
  traceSuspects(failedMeasurementPk: number) {
    const fail = this.db.prepare("SELECT * FROM measurements WHERE id = ?").get(failedMeasurementPk) as any;
    const lastPass = this.db
      .prepare(
        `SELECT m.* FROM measurements m
         JOIN judgements j ON j.measurement_id = m.id AND j.superseded_at IS NULL
         WHERE m.workorder_id = ? AND m.feature = ? AND m.measured_at < ? AND j.result = 'pass'
         ORDER BY m.measured_at DESC, m.id DESC LIMIT 1`
      )
      .get(fail.workorder_id, fail.feature, fail.measured_at) as any;
    const since = lastPass ? lastPass.measured_at : 0;
    const suspects = this.db
      .prepare(
        `SELECT m.*, j.result AS current_result FROM measurements m
         LEFT JOIN judgements j ON j.measurement_id = m.id AND j.superseded_at IS NULL
         WHERE m.workorder_id = ? AND m.feature = ? AND m.measured_at >= ? AND m.measured_at <= ?
         ORDER BY m.measured_at ASC, m.id ASC`
      )
      .all(fail.workorder_id, fail.feature, since, fail.measured_at) as any[];

    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(
          "INSERT INTO suspect_batches (workorder_id, feature, trigger_measurement_id, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(fail.workorder_id, fail.feature, fail.id, this.clock.now());
      const batchId = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO suspect_items (batch_id, workpiece_sn, classification, reason) VALUES (?, ?, ?, ?)"
      );
      for (const s of suspects) {
        const isReject = s.current_result === "fail";
        ins.run(
          batchId,
          s.workpiece_sn,
          isReject ? "reject" : "recheck",
          isReject
            ? "measured out of tolerance"
            : "produced after last known-good check; needs re-inspection"
        );
      }
      return batchId;
    });
    return tx();
  }

  recordQualityAction(actionId: string, workorderCode: string, workpieceSn: string, type: "scrap" | "rework", reason: string) {
    const tx = this.db.transaction(() => {
      const dup = this.db.prepare("SELECT id FROM quality_actions WHERE action_id = ?").get(actionId);
      if (dup) return { stored: false };
      const wo = this.db.prepare("SELECT * FROM workorders WHERE code = ?").get(workorderCode) as any;
      if (!wo) throw notFound(`workorder ${workorderCode}`);
      this.db
        .prepare(
          "INSERT INTO quality_actions (action_id, workorder_id, workpiece_sn, type, reason, ts) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(actionId, wo.id, workpieceSn, type, reason, this.clock.now());
      return { stored: true };
    });
    return tx();
  }

  /**
   * Correct a gauge calibration and re-evaluate every measurement taken with
   * that gauge at or after the corrected calibration time. Old judgements
   * are superseded and preserved.
   */
  correctCalibration(gaugeCode: string, calibratedAt: number, intervalDays: number, note = "correction") {
    const gauge = this.core.getGauge(gaugeCode);
    const tx = this.db.transaction(() => {
      this.core.addCalibration(gaugeCode, calibratedAt, intervalDays, note);
      const affected = this.db
        .prepare("SELECT id FROM measurements WHERE gauge_id = ? AND measured_at >= ?")
        .all(gauge.id, calibratedAt) as any[];
      let n = 0;
      for (const row of affected) {
        this.rejudge(row.id);
        n++;
      }
      return n;
    });
    return { reevaluated: tx() };
  }

  /** Re-judge every measurement under the current rules. */
  reevaluateAll(): number {
    const ids = this.db.prepare("SELECT id FROM measurements").all() as any[];
    for (const row of ids) this.rejudge(row.id);
    return ids.length;
  }

  private rejudge(measurementPk: number) {
    const m = this.db.prepare("SELECT * FROM measurements WHERE id = ?").get(measurementPk) as any;
    const cal = this.core.calibrationAt(m.gauge_id, m.measured_at);
    const gaugeExpired = !cal || cal.calibrated_at + cal.interval_days * 86400_000 < m.measured_at;
    const now = this.clock.now();
    this.db
      .prepare("UPDATE judgements SET superseded_at = ? WHERE measurement_id = ? AND superseded_at IS NULL")
      .run(now, measurementPk);
    const judgement = this.judge(measurementPk, gaugeExpired);
    if (judgement.result === "fail") this.traceSuspects(measurementPk);
    return judgement;
  }

  /** Full traceability report for a workorder. */
  traceabilityReport(workorderCode: string) {
    const wo = this.db
      .prepare(
        `SELECT w.*, p.code AS program_code, p.version AS program_version
         FROM workorders w JOIN programs p ON p.id = w.program_id WHERE w.code = ?`
      )
      .get(workorderCode) as any;
    if (!wo) throw notFound(`workorder ${workorderCode}`);
    const measurements = this.db
      .prepare(
        `SELECT m.*, g.code AS gauge_code,
                (SELECT j.result FROM judgements j WHERE j.measurement_id = m.id AND j.superseded_at IS NULL) AS current_result,
                (SELECT COUNT(*) FROM judgements j WHERE j.measurement_id = m.id) AS judgement_count
         FROM measurements m JOIN gauges g ON g.id = m.gauge_id
         WHERE m.workorder_id = ? ORDER BY m.measured_at ASC`
      )
      .all(wo.id) as any[];
    const segments = this.db
      .prepare(
        `SELECT s.*, t.serial AS tool_serial, te.edge_no, mc.code AS machine_code
         FROM cutting_segments s
         JOIN tool_edges te ON te.id = s.edge_id
         JOIN tools t ON t.id = te.tool_id
         JOIN machines mc ON mc.id = s.machine_id
         WHERE s.workorder_id = ? ORDER BY s.start_ts ASC`
      )
      .all(wo.id) as any[];
    const batches = this.db
      .prepare("SELECT * FROM suspect_batches WHERE workorder_id = ? ORDER BY id ASC")
      .all(wo.id) as any[];
    const items = this.db
      .prepare(
        `SELECT si.* FROM suspect_items si
         JOIN suspect_batches sb ON sb.id = si.batch_id WHERE sb.workorder_id = ? ORDER BY si.id ASC`
      )
      .all(wo.id) as any[];
    const actions = this.db
      .prepare("SELECT * FROM quality_actions WHERE workorder_id = ? ORDER BY ts ASC")
      .all(wo.id) as any[];
    return {
      workorder: {
        code: wo.code,
        partNo: wo.part_no,
        program: `${wo.program_code}@${wo.program_version}`,
        qtyTarget: wo.qty_target,
        status: wo.status,
      },
      cuttingSegments: segments,
      measurements,
      suspectBatches: batches.map((b) => ({ ...b, items: items.filter((i) => i.batch_id === b.id) })),
      qualityActions: actions,
    };
  }
}
