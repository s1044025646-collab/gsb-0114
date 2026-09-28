import type { Db } from '../db/connection.ts';
import { withTransaction } from '../db/connection.ts';
import { AppError, ErrorCodes } from './errors.ts';
import type { Clock } from './clock.ts';
import { iso } from './clock.ts';
import { findMountAt } from './mounts.ts';
import { requireNumber, requireString } from './validation.ts';

export type MachineEventType = 'cycle_start' | 'cycle_end' | 'mount' | 'dismount';

export interface MachineEventInput {
  uid: string;
  machineCode: string;
  type: MachineEventType;
  occurredAt: string;
  clockOffsetMs?: number;
  payload?: Record<string, unknown>;
}

interface RawRow {
  id: number;
  event_uid: string;
  machine_code: string;
  type: MachineEventType;
  occurred_at: string;
  payload_json: string;
}

/** Append raw event. Duplicate uid is ignored (idempotent ingestion). Returns false on dup. */
export function ingestEvent(db: Db, clock: Clock, input: MachineEventInput): boolean {
  const uid = requireString(input.uid, 'uid');
  const machineCode = requireString(input.machineCode, 'machineCode');
  if (!['cycle_start', 'cycle_end', 'mount', 'dismount'].includes(input.type))
    throw new AppError(ErrorCodes.VALIDATION, `unknown event type ${input.type}`);
  const rawAtMs = Date.parse(requireString(input.occurredAt, 'occurredAt'));
  if (Number.isNaN(rawAtMs))
    throw new AppError(ErrorCodes.VALIDATION, 'occurredAt must be ISO-8601');
  const offset = input.clockOffsetMs ?? 0;
  requireNumber(offset, 'clockOffsetMs');
  const canonicalAt = new Date(rawAtMs + offset).toISOString();

  return withTransaction(db, () => {
    const existing = db.prepare('SELECT id FROM machine_events WHERE event_uid=?').get(uid);
    if (existing) return false;
    db.prepare(
      `INSERT INTO machine_events
         (event_uid, machine_code, type, occurred_at, received_at, clock_offset_ms, payload_json, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid,
      machineCode,
      input.type,
      canonicalAt,
      canonicalAt,
      offset,
      JSON.stringify(input.payload ?? {}),
      iso(clock.now())
    );
    return true;
  });
}

function loadCycles(db: Db, machineCode?: string): RawRow[] {
  const rows = (
    machineCode
      ? db
          .prepare(
            `SELECT * FROM machine_events
             WHERE type IN ('cycle_start','cycle_end') AND machine_code=?
             ORDER BY occurred_at, id`
          )
          .all(machineCode)
      : db
          .prepare(
            `SELECT * FROM machine_events WHERE type IN ('cycle_start','cycle_end')
             ORDER BY occurred_at, id`
          )
          .all()
  ) as unknown as RawRow[];
  return rows;
}

/**
 * Recompute derived cut_segments from raw, append-only events.
 *
 * Rules:
 *  - Pair cycle_start/cycle_end per machine by canonical time; tolerate out-of-order
 *    ingestion because derivation sorts by time.
 *  - Duplicate uids are impossible (UNIQUE); same (start,end) pair -> UNIQUE ignored.
 *  - Each segment is attributed to the mount active at cycle start. Overlap with a
 *    later change is clipped at the dismount boundary; time outside the mount is
 *    dropped (never accumulated against the wrong edge).
 *  - Program version/work order come from the start payload and must resolve.
 *  - Overlapping cycles on the same edge (e.g. double-started machine) are
 *    union-clipped so wall time is never counted twice.
 */
export function deriveSegments(db: Db, clock: Clock, machineCode?: string): { created: number; clipped: number } {
  return withTransaction(db, () => {
    const rows = loadCycles(db, machineCode);
    const byMachine = new Map<string, RawRow[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machine_code) ?? [];
      list.push(r);
      byMachine.set(r.machine_code, list);
    }

    let created = 0;
    let clipped = 0;
    for (const [mc, list] of byMachine) {
      const opens: RawRow[] = [];
      const pairs: { start: RawRow; end: RawRow }[] = [];
      for (const row of list) {
        if (row.type === 'cycle_start') opens.push(row);
        else if (opens.length > 0) {
          const start = opens.shift()!;
          if (Date.parse(row.occurred_at) >= Date.parse(start.occurred_at)) pairs.push({ start, end: row });
        }
      }

      // Clip every pair to its mount window; collect intervals per edge for union.
      type Interval = { startMs: number; endMs: number; edgeId: number; mountId: number; programId: number; wo: string | null; startUid: string; endUid: string };
      const perEdge = new Map<number, Interval[]>();
      for (const { start, end } of pairs) {
        const startPayload = JSON.parse(start.payload_json) as {
          program?: string;
          programVersion?: string;
          workOrderCode?: string;
        };
        const programName = requireString(startPayload.program ?? '', 'payload.program');
        const programVersion = requireString(startPayload.programVersion ?? '', 'payload.programVersion');
        const prog = db
          .prepare('SELECT id FROM programs WHERE name=? AND version=?')
          .get(programName, programVersion) as { id: number } | undefined;
        if (!prog) throw new AppError(ErrorCodes.NOT_FOUND, `program ${programName}@${programVersion} not found`);

        let startMs = Date.parse(start.occurred_at);
        let endMs = Date.parse(end.occurred_at);
        const mount = findMountAt(db, mc, start.occurred_at);
        if (!mount) continue; // cutting with no known mounted edge: not attributable, skip
        const mountEndMs = mount.dismountedAt ? Date.parse(mount.dismountedAt) : Infinity;
        const mountStartMs = Date.parse(mount.mountedAt);
        const origEnd = endMs;
        startMs = Math.max(startMs, mountStartMs);
        endMs = Math.min(endMs, mountEndMs);
        if (endMs <= startMs) continue;
        if (endMs < origEnd) clipped++;

        const intervals = perEdge.get(mount.edgeId) ?? [];
        intervals.push({
          startMs,
          endMs,
          edgeId: mount.edgeId,
          mountId: mount.mountId,
          programId: prog.id,
          wo: (startPayload.workOrderCode as string | undefined) ?? null,
          startUid: start.event_uid,
          endUid: end.event_uid,
        });
        perEdge.set(mount.edgeId, intervals);
      }

      // Union merge overlapping intervals on the same edge -> no double life accrual.
      for (const intervals of perEdge.values()) {
        intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
        const merged: Interval[] = [];
        for (const iv of intervals) {
          const last = merged.at(-1);
          if (last && iv.startMs <= last.endMs) {
            if (iv.endMs > last.endMs) last.endMs = iv.endMs;
          } else merged.push({ ...iv });
        }
        for (const iv of merged) {
          const duration = iv.endMs - iv.startMs;
          try {
            db.prepare(
              `INSERT INTO cut_segments
                 (machine_code, edge_id, mount_id, program_id, work_order_code,
                  start_at, end_at, duration_ms, start_event_uid, end_event_uid)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              mc,
              iv.edgeId,
              iv.mountId,
              iv.programId,
              iv.wo,
              new Date(iv.startMs).toISOString(),
              new Date(iv.endMs).toISOString(),
              duration,
              iv.startUid,
              iv.endUid
            );
            created++;
          } catch (err) {
            if (err instanceof Error && err.message.includes('UNIQUE')) continue;
            throw err;
          }
        }
      }
    }
    db.prepare(
      `INSERT INTO audit_log(at, actor, action, entity, after_json)
       VALUES (?, 'system', 'derive_segments', 'cut_segments', ?)`
    ).run(iso(clock.now()), JSON.stringify({ created, clipped, machineCode: machineCode ?? null }));
    return { created, clipped };
  });
}

export interface EdgeLife {
  edgeId: number;
  toolSerial: string;
  edgeNo: number;
  usedMs: number;
  limitMs: number;
  remainingMs: number;
  remainingRatio: number;
  expired: boolean;
}

export function computeEdgeLife(db: Db, edgeId: number): EdgeLife {
  const edge = db
    .prepare(
      `SELECT e.id, e.edge_no, e.life_limit_ms, t.serial
       FROM tool_edges e JOIN tools t ON t.id=e.tool_id WHERE e.id=?`
    )
    .get(edgeId) as { id: number; edge_no: number; life_limit_ms: number; serial: string } | undefined;
  if (!edge) throw new AppError(ErrorCodes.NOT_FOUND, `edge ${edgeId} not found`);
  const row = db
    .prepare('SELECT COALESCE(SUM(duration_ms),0) AS used FROM cut_segments WHERE edge_id=?')
    .get(edgeId) as { used: number };
  const usedMs = row.used;
  const remainingMs = edge.life_limit_ms - usedMs;
  return {
    edgeId,
    toolSerial: edge.serial,
    edgeNo: edge.edge_no,
    usedMs,
    limitMs: edge.life_limit_ms,
    remainingMs,
    remainingRatio: remainingMs / edge.life_limit_ms,
    expired: remainingMs <= 0,
  };
}

export function listEdgeLife(db: Db): EdgeLife[] {
  const rows = db.prepare('SELECT id FROM tool_edges ORDER BY id').all() as { id: number }[];
  return rows.map((r) => computeEdgeLife(db, r.id));
}

/** Raise life alerts for edges at/below threshold; one alert per edge per crossing level. */
export function raiseLifeAlerts(db: Db, clock: Clock, warnRatio = 0.2): number {
  return withTransaction(db, () => {
    let count = 0;
    for (const life of listEdgeLife(db)) {
      const level = life.expired ? 'expired' : life.remainingRatio <= warnRatio ? 'life_warn' : null;
      if (!level) continue;
      const subject = `${life.toolSerial}#${life.edgeNo}`;
      const exists = db
        .prepare(
          `SELECT 1 FROM alerts WHERE kind=? AND subject=?
           AND json_extract(payload_json,'$.usedMs')=?`
        )
        .get(level, subject, life.usedMs);
      if (exists) continue;
      db.prepare('INSERT INTO alerts(kind, subject, message, created_at, payload_json) VALUES (?, ?, ?, ?, ?)')
        .run(
          level,
          subject,
          level === 'expired'
            ? `edge ${subject} life exhausted (${life.usedMs}/${life.limitMs} ms)`
            : `edge ${subject} remaining life ${(life.remainingRatio * 100).toFixed(1)}%`,
          iso(clock.now()),
          JSON.stringify(life)
        );
      count++;
    }
    return count;
  });
}
