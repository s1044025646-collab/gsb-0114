import type { Db } from '../db/connection.ts';
import { withTransaction } from '../db/connection.ts';
import { AppError, ErrorCodes } from './errors.ts';
import type { Clock } from './clock.ts';
import { iso } from './clock.ts';
import { getGaugeStatus } from './catalog.ts';
import { check, requireIso, requireNumber, requireString } from './validation.ts';

export interface MeasurementInput {
  workOrderCode: string;
  serial: string;
  featureKey: string;
  gaugeCode: string;
  measuredAt: string;
  rawValue: number;
  allowExpiredGauge?: boolean;
}

interface FeatureRow {
  nominal: number;
  usl: number;
  lsl: number;
}

/** Scrap threshold per feature, adjustable. Stored in feature_scrap_rules (1:1). */
interface ScrapRule {
  scrapBandRatio: number;
}

function ensureRuleTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS feature_scrap_rules (
       feature_id INTEGER PRIMARY KEY REFERENCES features(id),
       scrap_band_ratio REAL NOT NULL DEFAULT 0.5,
       updated_at TEXT NOT NULL
     )`
  );
}

function getFeature(db: Db, woCode: string, key: string): { id: number } & FeatureRow & ScrapRule {
  const row = db
    .prepare(
      `SELECT f.id, f.nominal, f.usl, f.lsl, r.scrap_band_ratio
       FROM features f
       JOIN work_orders w ON w.id = f.work_order_id
       LEFT JOIN feature_scrap_rules r ON r.feature_id = f.id
       WHERE w.code = ? AND f.key = ?`
    )
    .get(woCode, key) as
    | ({ id: number; scrap_band_ratio: number | null } & FeatureRow)
    | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `feature ${key} of ${woCode} not found`);
  const { scrap_band_ratio: rawRatio, ...rest } = row;
  return { ...rest, scrapBandRatio: rawRatio ?? 0.5 };
}

function verdictFor(value: number, f: FeatureRow & ScrapRule): 'ok' | 'fail' {
  return value >= f.lsl && value <= f.usl ? 'ok' : 'fail';
}

function dispositionFor(value: number, f: FeatureRow & ScrapRule): 'reinspect' | 'scrap' | 'rework' {
  if (value >= f.lsl && value <= f.usl) return 'reinspect';
  const span = f.usl - f.lsl;
  const over = value > f.usl ? value - f.usl : value < f.lsl ? f.lsl - value : 0;
  return over > span * f.scrapBandRatio ? 'scrap' : 'rework';
}

export interface MeasurementResult {
  measurementId: number;
  correctedValue: number;
  verdict: 'ok' | 'fail';
  gaugeExpired: boolean;
  calibrationId: number;
}

/**
 * Append a raw measurement (immutable). corrected_value applies the current
 * gauge bias. Expired gauges are rejected unless allowExpiredGauge is set.
 */
export function recordMeasurement(db: Db, clock: DbClock, input: MeasurementInput): MeasurementResult {
  const woCode = requireString(input.workOrderCode, 'workOrderCode');
  const serial = requireString(input.serial, 'serial');
  const featureKey = requireString(input.featureKey, 'featureKey');
  const gaugeCode = requireString(input.gaugeCode, 'gaugeCode');
  const measuredAt = requireIso(input.measuredAt, 'measuredAt');
  const rawValue = requireNumber(input.rawValue, 'rawValue');

  return withTransaction(db, () => {
    ensureRuleTable(db);
    const feature = getFeature(db, woCode, featureKey);
    const gauge = getGaugeStatus(db, new Date(measuredAt), gaugeCode);
    if (gauge.featureKey !== featureKey)
      throw new AppError(
        ErrorCodes.VALIDATION,
        `gauge ${gaugeCode} is for feature ${gauge.featureKey}, not ${featureKey}`
      );
    if (gauge.expired && !input.allowExpiredGauge)
      throw new AppError(ErrorCodes.GAUGE_EXPIRED, `gauge ${gaugeCode} calibration expired at ${gauge.expiredAt}`, {
        expiredAt: gauge.expiredAt,
      });

    const cal = db
      .prepare('SELECT id, bias FROM gauge_calibrations WHERE gauge_id=? AND superseded=0')
      .get(gauge.id) as { id: number; bias: number };
    const correctedValue = rawValue - cal.bias;
    const verdict = verdictFor(correctedValue, feature);

    try {
      const info = db
        .prepare(
          `INSERT INTO measurements
             (work_order_code, serial, feature_key, gauge_code, measured_at, recorded_at,
              raw_value, corrected_value, calibration_id, verdict)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          woCode,
          serial,
          featureKey,
          gaugeCode,
          measuredAt,
          iso(clock.now()),
          rawValue,
          correctedValue,
          cal.id,
          verdict
        );
      const measurementId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO dispositions(work_order_code, serial, kind, reason, decided_at)
         VALUES (?, ?, 'ok', 'initial', ?)`
      ).run(woCode, serial, iso(clock.now()));
      if (verdict === 'fail') traceSuspiciousBatch(db, clock, woCode, featureKey, measurementId, feature);
      return { measurementId, correctedValue, verdict, gaugeExpired: gauge.expired, calibrationId: cal.id };
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE'))
        throw new AppError(ErrorCodes.DUPLICATE_EVENT, 'duplicate measurement');
      throw err;
    }
  });
}

type DbClock = Clock;

interface MeasRow {
  id: number;
  serial: string;
  corrected_value: number;
  measured_at: string;
  verdict: string;
}

/**
 * Suspect window = serials produced since the last PASSING measurement (by
 * measured_at), inclusive of the failing one. reinspect vs confirmed_bad:
 *  - confirmed_bad: the trigger part itself is beyond scrap band (definite NG)
 *  - reinspect: failure inside rework band, or gauge calibration was expired
 *    (reading unreliable -> re-inspect only)
 */
function traceSuspiciousBatch(
  db: Db,
  clock: Clock,
  woCode: string,
  featureKey: string,
  triggerId: number,
  feature: FeatureRow & ScrapRule
): void {
  const trigger = db.prepare('SELECT * FROM measurements WHERE id=?').get(triggerId) as unknown as MeasRow;
  const gaugeRow = db
    .prepare(
      `SELECT g.calibrated_at, g.calibration_interval_ms
       FROM measurements m JOIN gauges g ON g.code = m.gauge_code WHERE m.id=?`
    )
    .get(triggerId) as { calibrated_at: string; calibration_interval_ms: number };
  const expired =
    Date.parse(trigger.measured_at) >
    Date.parse(gaugeRow.calibrated_at) + gaugeRow.calibration_interval_ms;

  const prev = db
    .prepare(
      `SELECT * FROM measurements
       WHERE work_order_code=? AND feature_key=? AND measured_at < ? AND verdict='ok'
       ORDER BY measured_at DESC, id DESC LIMIT 1`
    )
    .get(woCode, featureKey, trigger.measured_at) as MeasRow | undefined;

  const windowRows = db
    .prepare(
      `SELECT serial FROM measurements
       WHERE work_order_code=? AND feature_key=?
         AND measured_at > COALESCE(?, '1970-01-01T00:00:00Z')
         AND measured_at <= ?
       ORDER BY measured_at, id`
    )
    .all(woCode, featureKey, prev?.measured_at ?? null, trigger.measured_at) as { serial: string }[];

  const fromSerial = windowRows[0]?.serial ?? trigger.serial;
  const toSerial = trigger.serial;
  const kind = dispositionFor(trigger.corrected_value, feature);
  const confidence = !expired && kind === 'scrap' ? 'confirmed_bad' : 'reinspect';

  db.prepare(
    `INSERT INTO trace_batches
       (work_order_code, feature_key, trigger_measurement_id, since_measurement_id,
        from_serial, to_serial, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    woCode,
    featureKey,
    triggerId,
    prev?.id ?? null,
    fromSerial,
    toSerial,
    confidence,
    iso(clock.now())
  );

  db.prepare(
    `INSERT INTO alerts(kind, subject, message, created_at, payload_json)
     VALUES ('quality', ?, ?, ?, ?)`
  ).run(
    `${woCode}:${featureKey}`,
    `${confidence === 'confirmed_bad' ? 'CONFIRMED NG' : 'RE-INSPECT'} batch ${fromSerial}..${toSerial}`,
    iso(clock.now()),
    JSON.stringify({ triggerId, fromSerial, toSerial, confidence })
  );

  // Disposition each serial in the window.
  for (const part of windowRows) {
    const d = part.serial === trigger.serial && !expired ? kind : 'reinspect';
    db.prepare(
      `INSERT INTO dispositions(work_order_code, serial, kind, reason, decided_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(woCode, part.serial, d, `trace:${confidence}`, iso(clock.now()));
  }
}

/**
 * Re-evaluate after a calibration correction or scrap-threshold change.
 * Old measurement rows and verdicts are retained (superseded=1, audit intact);
 * new rows carry the new corrected values/verdicts and a reason.
 */
export function reevaluate(
  db: Db,
  clock: Clock,
  input: { workOrderCode?: string; reason: string }
): number {
  return withTransaction(db, () => {
    ensureRuleTable(db);
    const rows = (
      input.workOrderCode
        ? db
            .prepare(
              `SELECT m.* FROM measurements m
               WHERE m.work_order_code=? AND m.superseded=0
               ORDER BY m.measured_at, m.id`
            )
            .all(input.workOrderCode)
        : db
            .prepare(
              `SELECT m.* FROM measurements m
               WHERE m.superseded=0 ORDER BY m.measured_at, m.id`
            )
            .all()
    ) as Array<{
      id: number;
      work_order_code: string;
      serial: string;
      feature_key: string;
      gauge_code: string;
      measured_at: string;
      raw_value: number;
    }>;

    let count = 0;
    for (const m of rows) {
      const feature = getFeature(db, m.work_order_code, m.feature_key);
      const gauge = getGaugeStatus(db, new Date(m.measured_at), m.gauge_code);
      const cal = db
        .prepare('SELECT id, bias FROM gauge_calibrations WHERE gauge_id=? AND superseded=0')
        .get(gauge.id) as { id: number; bias: number };
      const correctedValue = m.raw_value - cal.bias;
      const verdict = verdictFor(correctedValue, feature);

      db.prepare('UPDATE measurements SET superseded=1 WHERE id=?').run(m.id);
      db.prepare(
        `INSERT INTO measurements
           (work_order_code, serial, feature_key, gauge_code, measured_at, recorded_at,
            raw_value, corrected_value, calibration_id, verdict, superseded, reeval_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        m.work_order_code,
        m.serial,
        m.feature_key,
        m.gauge_code,
        m.measured_at,
        iso(clock.now()),
        m.raw_value,
        correctedValue,
        cal.id,
        verdict,
        input.reason
      );
      db.prepare(
        `INSERT INTO audit_log(at, actor, action, entity, entity_id, before_json, after_json)
         VALUES (?, 'system', 'reevaluate', 'measurement', ?, ?, ?)`
      ).run(
        iso(clock.now()),
        String(m.id),
        JSON.stringify({ oldId: m.id }),
        JSON.stringify({ correctedValue, verdict, reason: input.reason })
      );
      count++;
    }

    // Replay fresh measurements per (work order, feature) in time order and
    // rebuild trace windows against the new verdicts. Old batches are marked
    // superseded but retained for audit.
    const groups = new Map<string, { wo: string; key: string }>();
    for (const m of rows)
      groups.set(`${m.work_order_code}|${m.feature_key}`, { wo: m.work_order_code, key: m.feature_key });
    for (const g of groups.values()) {
      db.prepare(
        'UPDATE trace_batches SET superseded=1 WHERE work_order_code=? AND feature_key=?'
      ).run(g.wo, g.key);
      const fresh = db
        .prepare(
          `SELECT id FROM measurements
           WHERE work_order_code=? AND feature_key=? AND superseded=0
           ORDER BY measured_at, id`
        )
        .all(g.wo, g.key) as { id: number }[];
      const feature = getFeature(db, g.wo, g.key);
      for (const m of fresh) {
        const row = db.prepare('SELECT verdict FROM measurements WHERE id=?').get(m.id) as {
          verdict: string;
        };
        if (row.verdict === 'fail') traceSuspiciousBatch(db, clock, g.wo, g.key, m.id, feature);
      }
    }
    return count;
  });
}

export function setScrapThreshold(
  db: Db,
  clock: Clock,
  input: { workOrderCode: string; featureKey: string; scrapBandRatio: number }
): void {
  const ratio = requireNumber(input.scrapBandRatio, 'scrapBandRatio');
  check(ratio >= 0 && ratio <= 10, 'scrapBandRatio must be >= 0');
  withTransaction(db, () => {
    ensureRuleTable(db);
    const feature = getFeature(db, input.workOrderCode, input.featureKey);
    db.prepare(
      `INSERT INTO feature_scrap_rules(feature_id, scrap_band_ratio, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(feature_id) DO UPDATE SET scrap_band_ratio=excluded.scrap_band_ratio,
                                             updated_at=excluded.updated_at`
    ).run(feature.id, ratio, iso(clock.now()));
    db.prepare(
      `INSERT INTO audit_log(at, actor, action, entity, entity_id, after_json)
       VALUES (?, 'cli', 'set_scrap_threshold', 'feature', ?, ?)`
    ).run(iso(clock.now()), String(feature.id), JSON.stringify({ ratio }));
  });
}
