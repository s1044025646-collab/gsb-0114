import type { Db } from '../db/connection.ts';
import { withTransaction } from '../db/connection.ts';
import { AppError, ErrorCodes } from './errors.ts';
import type { Clock } from './clock.ts';
import { iso } from './clock.ts';
import { check, requireIso, requireNumber, requirePositiveInt, requireString } from './validation.ts';

function audit(
  db: Db,
  clock: Clock,
  action: string,
  entity: string,
  entityId: string | number,
  before: unknown,
  after: unknown
): void {
  db.prepare(
    `INSERT INTO audit_log(at, actor, action, entity, entity_id, before_json, after_json)
     VALUES (?, 'cli', ?, ?, ?, ?, ?)`
  ).run(
    iso(clock.now()),
    action,
    entity,
    String(entityId),
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after)
  );
}

export function createMachine(db: Db, clock: Clock, input: { code: string; name: string }): number {
  const code = requireString(input.code, 'code');
  const name = requireString(input.name, 'name');
  return withTransaction(db, () => {
    const info = db
      .prepare('INSERT INTO machines(code, name, created_at) VALUES (?, ?, ?)')
      .run(code, name, iso(clock.now()));
    const id = Number(info.lastInsertRowid);
    audit(db, clock, 'create', 'machine', id, undefined, { code, name });
    return id;
  });
}

export function createTool(
  db: Db,
  clock: Clock,
  input: { serial: string; description?: string; lifeLimitMs: number; edges?: number; edgeLifeLimitMs?: number }
): number {
  const serial = requireString(input.serial, 'serial');
  const lifeLimitMs = requirePositiveInt(input.lifeLimitMs, 'lifeLimitMs');
  const edgeCount = input.edges ?? 1;
  check(Number.isInteger(edgeCount) && edgeCount >= 1 && edgeCount <= 32, 'edges must be 1..32');
  const edgeLife = requirePositiveInt(input.edgeLifeLimitMs ?? lifeLimitMs, 'edgeLifeLimitMs');
  return withTransaction(db, () => {
    const info = db
      .prepare('INSERT INTO tools(serial, description, life_limit_ms, created_at) VALUES (?, ?, ?, ?)')
      .run(serial, input.description ?? '', lifeLimitMs, iso(clock.now()));
    const toolId = Number(info.lastInsertRowid);
    const edgeStmt = db.prepare(
      'INSERT INTO tool_edges(tool_id, edge_no, life_limit_ms, created_at) VALUES (?, ?, ?, ?)'
    );
    for (let i = 1; i <= edgeCount; i++) edgeStmt.run(toolId, i, edgeLife, iso(clock.now()));
    audit(db, clock, 'create', 'tool', toolId, undefined, { serial, lifeLimitMs, edgeCount, edgeLife });
    return toolId;
  });
}

export function createProgram(
  db: Db,
  clock: Clock,
  input: { name: string; version: string }
): number {
  const name = requireString(input.name, 'name');
  const version = requireString(input.version, 'version');
  return withTransaction(db, () => {
    const exists = db.prepare('SELECT id FROM programs WHERE name=? AND version=?').get(name, version);
    if (exists) throw new AppError(ErrorCodes.CONFLICT, `program ${name}@${version} already exists`);
    const info = db
      .prepare('INSERT INTO programs(name, version, created_at) VALUES (?, ?, ?)')
      .run(name, version, iso(clock.now()));
    const id = Number(info.lastInsertRowid);
    audit(db, clock, 'create', 'program', id, undefined, { name, version });
    return id;
  });
}

export function createWorkOrder(
  db: Db,
  clock: Clock,
  input: { code: string; partNo: string; qty: number }
): number {
  const code = requireString(input.code, 'code');
  const partNo = requireString(input.partNo, 'partNo');
  const qty = requirePositiveInt(input.qty, 'qty');
  return withTransaction(db, () => {
    const info = db
      .prepare('INSERT INTO work_orders(code, part_no, qty, created_at) VALUES (?, ?, ?, ?)')
      .run(code, partNo, qty, iso(clock.now()));
    const id = Number(info.lastInsertRowid);
    audit(db, clock, 'create', 'work_order', id, undefined, { code, partNo, qty });
    return id;
  });
}

export function addFeature(
  db: Db,
  clock: Clock,
  input: { workOrderCode: string; key: string; nominal: number; usl: number; lsl: number }
): number {
  const woCode = requireString(input.workOrderCode, 'workOrderCode');
  const key = requireString(input.key, 'key');
  const nominal = requireNumber(input.nominal, 'nominal');
  const usl = requireNumber(input.usl, 'usl');
  const lsl = requireNumber(input.lsl, 'lsl');
  check(usl >= nominal && nominal >= lsl && usl > lsl, 'require lsl <= nominal <= usl and lsl < usl');
  return withTransaction(db, () => {
    const wo = db.prepare('SELECT id FROM work_orders WHERE code=?').get(woCode) as
      | { id: number }
      | undefined;
    if (!wo) throw new AppError(ErrorCodes.NOT_FOUND, `work order ${woCode} not found`);
    try {
      const info = db
        .prepare(
          'INSERT INTO features(work_order_id, key, nominal, usl, lsl) VALUES (?, ?, ?, ?, ?)'
        )
        .run(wo.id, key, nominal, usl, lsl);
      const id = Number(info.lastInsertRowid);
      audit(db, clock, 'create', 'feature', id, undefined, { woCode, key, nominal, usl, lsl });
      return id;
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE'))
        throw new AppError(ErrorCodes.CONFLICT, `feature ${key} already exists on ${woCode}`);
      throw err;
    }
  });
}

export interface GaugeStatus {
  id: number;
  code: string;
  featureKey: string;
  calibratedAt: string;
  calibrationIntervalMs: number;
  bias: number;
  expiredAt: string;
  expired: boolean;
}

export function createGauge(
  db: Db,
  clock: Clock,
  input: {
    code: string;
    featureKey: string;
    calibrationIntervalMs: number;
    calibratedAt?: string;
    bias?: number;
  }
): number {
  const code = requireString(input.code, 'code');
  const featureKey = requireString(input.featureKey, 'featureKey');
  const interval = requirePositiveInt(input.calibrationIntervalMs, 'calibrationIntervalMs');
  const calibratedAt = input.calibratedAt ? requireIso(input.calibratedAt, 'calibratedAt') : iso(clock.now());
  const bias = input.bias ?? 0;
  requireNumber(bias, 'bias');
  return withTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO gauges(code, feature_key, calibration_interval_ms, calibrated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(code, featureKey, interval, calibratedAt);
    const id = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO gauge_calibrations(gauge_id, calibrated_at, bias, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, calibratedAt, bias, iso(clock.now()));
    audit(db, clock, 'create', 'gauge', id, undefined, { code, featureKey, interval, calibratedAt, bias });
    return id;
  });
}

/**
 * Correct a gauge calibration. The old calibration row is retained (superseded=1)
 * and measurements using it are re-evaluated; old verdicts remain for audit.
 */
export function recorrectGauge(
  db: Db,
  clock: Clock,
  input: { code: string; calibratedAt: string; bias: number }
): number {
  const code = requireString(input.code, 'code');
  const calibratedAt = requireIso(input.calibratedAt, 'calibratedAt');
  const bias = requireNumber(input.bias, 'bias');
  return withTransaction(db, () => {
    const gauge = db.prepare('SELECT * FROM gauges WHERE code=?').get(code) as
      | { id: number; feature_key: string; calibration_interval_ms: number }
      | undefined;
    if (!gauge) throw new AppError(ErrorCodes.NOT_FOUND, `gauge ${code} not found`);
    db.prepare('UPDATE gauge_calibrations SET superseded=1 WHERE gauge_id=? AND superseded=0').run(
      gauge.id
    );
    const info = db
      .prepare(
        `INSERT INTO gauge_calibrations(gauge_id, calibrated_at, bias, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(gauge.id, calibratedAt, bias, iso(clock.now()));
    const calId = Number(info.lastInsertRowid);
    db.prepare('UPDATE gauges SET calibrated_at=? WHERE id=?').run(calibratedAt, gauge.id);
    audit(db, clock, 'recalibrate', 'gauge', gauge.id, undefined, { calibratedAt, bias });
    return calId;
  });
}

export function getGaugeStatus(db: Db, at: Date, code: string): GaugeStatus {
  const gauge = db
    .prepare(
      `SELECT g.id, g.code, g.feature_key, g.calibration_interval_ms, g.calibrated_at, c.bias
       FROM gauges g JOIN gauge_calibrations c
         ON c.gauge_id = g.id AND c.superseded = 0
       WHERE g.code = ?`
    )
    .get(code) as
    | {
        id: number;
        code: string;
        feature_key: string;
        calibration_interval_ms: number;
        calibrated_at: string;
        bias: number;
      }
    | undefined;
  if (!gauge) throw new AppError(ErrorCodes.NOT_FOUND, `gauge ${code} not found`);
  const expiredAtMs = Date.parse(gauge.calibrated_at) + gauge.calibration_interval_ms;
  return {
    id: gauge.id,
    code: gauge.code,
    featureKey: gauge.feature_key,
    calibratedAt: gauge.calibrated_at,
    calibrationIntervalMs: gauge.calibration_interval_ms,
    bias: gauge.bias,
    expiredAt: new Date(expiredAtMs).toISOString(),
    expired: at.getTime() > expiredAtMs,
  };
}

export function listMachines(db: Db): unknown[] {
  return db.prepare('SELECT * FROM machines ORDER BY code').all();
}
export function listTools(db: Db): unknown[] {
  return db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM tool_edges e WHERE e.tool_id=t.id) AS edge_count
       FROM tools t ORDER BY t.serial`
    )
    .all();
}
