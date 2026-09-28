import type { Db } from '../db/connection.ts';
import { withTransaction } from '../db/connection.ts';
import { AppError, ErrorCodes } from './errors.ts';
import type { Clock } from './clock.ts';
import { iso } from './clock.ts';
import { requireIso, requireString } from './validation.ts';

export interface MountInput {
  toolSerial: string;
  edgeNo: number;
  machineCode: string;
  mountedAt: string;
  dismountedAt?: string;
  reason?: string;
}

function resolveEdge(
  db: Db,
  toolSerial: string,
  edgeNo: number
): { edgeId: number; toolId: number } {
  const row = db
    .prepare(
      `SELECT e.id AS edge_id, e.active, t.retired, t.id AS tool_id
       FROM tools t JOIN tool_edges e ON e.tool_id = t.id
       WHERE t.serial = ? AND e.edge_no = ?`
    )
    .get(toolSerial, edgeNo) as
    | { edge_id: number; active: number; retired: number; tool_id: number }
    | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `edge ${toolSerial}#${edgeNo} not found`);
  if (!row.active || row.retired)
    throw new AppError(ErrorCodes.INVALID_STATE, `edge ${toolSerial}#${edgeNo} is retired`);
  return { edgeId: row.edge_id, toolId: row.tool_id };
}

function resolveMachine(db: Db, code: string): number {
  const row = db.prepare('SELECT id FROM machines WHERE code=?').get(code) as { id: number } | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `machine ${code} not found`);
  return row.id;
}

/**
 * Record a mount interval. Enforces (inside one SERIALIZABLE-ish IMMEDIATE
 * transaction) that an edge is never mounted on two machines at overlapping
 * times, and that open-ended mounts do not coexist.
 */
export function recordMount(db: Db, clock: Clock, input: MountInput): number {
  const toolSerial = requireString(input.toolSerial, 'toolSerial');
  const machineCode = requireString(input.machineCode, 'machineCode');
  const edgeNo = Math.trunc(Number(input.edgeNo));
  if (!Number.isInteger(edgeNo) || edgeNo < 1)
    throw new AppError(ErrorCodes.VALIDATION, 'edgeNo must be a positive integer');
  const mountedAt = requireIso(input.mountedAt, 'mountedAt');
  const dismountedAt = input.dismountedAt ? requireIso(input.dismountedAt, 'dismountedAt') : null;
  if (dismountedAt && dismountedAt <= mountedAt)
    throw new AppError(ErrorCodes.VALIDATION, 'dismountedAt must be after mountedAt');

  return withTransaction(db, () => {
    const { edgeId } = resolveEdge(db, toolSerial, edgeNo);
    const machineId = resolveMachine(db, machineCode);

    const overlapping = db
      .prepare(
        `SELECT m.id, mc.code AS machine_code, m.mounted_at, m.dismounted_at
         FROM tool_mounts m JOIN machines mc ON mc.id = m.machine_id
         WHERE m.edge_id = ?
           AND (m.dismounted_at IS NULL
                OR ? IS NULL
                OR m.dismounted_at > ?)
           AND m.mounted_at < COALESCE(?, '9999-12-31T00:00:00Z')`
      )
      .all(edgeId, dismountedAt, mountedAt, dismountedAt) as Array<{
      id: number;
      machine_code: string;
      mounted_at: string;
      dismounted_at: string | null;
    }>;
    if (overlapping.length > 0) {
      throw new AppError(
        ErrorCodes.EDGE_BUSY,
        `edge ${toolSerial}#${edgeNo} already mounted during that interval`,
        overlapping
      );
    }

    const info = db
      .prepare(
        `INSERT INTO tool_mounts(edge_id, machine_id, mounted_at, dismounted_at, reason)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(edgeId, machineId, mountedAt, dismountedAt, input.reason ?? 'change');
    const mountId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO audit_log(at, actor, action, entity, entity_id, after_json)
       VALUES (?, 'cli', 'mount', 'tool_mount', ?, ?)`
    ).run(
      iso(clock.now()),
      String(mountId),
      JSON.stringify({ toolSerial, edgeNo, machineCode, mountedAt, dismountedAt })
    );
    return mountId;
  });
}

export function dismountEdge(
  db: Db,
  clock: Clock,
  input: { toolSerial: string; edgeNo: number; machineCode: string; at: string }
): void {
  const at = requireIso(input.at, 'at');
  withTransaction(db, () => {
    const { edgeId } = resolveEdge(db, input.toolSerial, input.edgeNo);
    const machineId = resolveMachine(db, input.machineCode);
    const row = db
      .prepare(
        `SELECT id, mounted_at FROM tool_mounts
         WHERE edge_id=? AND machine_id=? AND dismounted_at IS NULL
         ORDER BY mounted_at DESC LIMIT 1`
      )
      .get(edgeId, machineId) as { id: number; mounted_at: string } | undefined;
    if (!row)
      throw new AppError(
        ErrorCodes.INVALID_STATE,
        `no active mount of ${input.toolSerial}#${input.edgeNo} on ${input.machineCode}`
      );
    if (at <= row.mounted_at)
      throw new AppError(ErrorCodes.VALIDATION, 'dismount time must be after mount time');
    db.prepare('UPDATE tool_mounts SET dismounted_at=? WHERE id=?').run(at, row.id);
    db.prepare(
      `INSERT INTO audit_log(at, actor, action, entity, entity_id, after_json)
       VALUES (?, 'cli', 'dismount', 'tool_mount', ?, ?)`
    ).run(iso(clock.now()), String(row.id), JSON.stringify({ at }));
  });
}

/**
 * Find the mount that owns a given machine/time point.
 * Cutting that straddles a mount boundary is clipped to the mounted window;
 * intervals outside every mount are rejected (never silently accumulated).
 */
export function findMountAt(
  db: Db,
  machineCode: string,
  atIso: string
): { mountId: number; edgeId: number; mountedAt: string; dismountedAt: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT m.id AS mount_id, m.edge_id, m.mounted_at, m.dismounted_at
       FROM tool_mounts m JOIN machines mc ON mc.id = m.machine_id
       WHERE mc.code = ? AND m.mounted_at <= ?
         AND (m.dismounted_at IS NULL OR m.dismounted_at > ?)
       ORDER BY m.mounted_at DESC LIMIT 1`
    )
    .get(machineCode, atIso, atIso) as
    | { mount_id: number; edge_id: number; mounted_at: string; dismounted_at: string | null }
    | undefined;
  return row
    ? { mountId: row.mount_id, edgeId: row.edge_id, mountedAt: row.mounted_at, dismountedAt: row.dismounted_at }
    : undefined;
}
