import { DB } from "../db";
import { Clock } from "../clock";
import { AppError, notFound } from "../errors";

export interface MachineEvent {
  eventId: string;
  machineCode: string;
  type: "cutting_start" | "cutting_stop" | "tool_install" | "tool_remove";
  ts: number;
  seq?: number;
  payload?: Record<string, unknown>;
}

export class EventService {
  constructor(private db: DB, private clock: Clock) {}

  /**
   * Install an edge on a machine inside a transaction. The partial unique
   * index `uq_active_install_per_edge` guarantees that even concurrent
   * installs cannot make one edge active on two machines at once.
   */
  installEdge(toolSerial: string, edgeNo: number, machineCode: string, ts?: number) {
    const at = ts ?? this.clock.now();
    const tx = this.db.transaction(() => {
      const edge = this.findEdge(toolSerial, edgeNo);
      if (edge.status !== "active") throw new AppError("CONFLICT", `edge is ${edge.status}`, 409);
      const machine = this.db.prepare("SELECT * FROM machines WHERE code = ?").get(machineCode) as any;
      if (!machine) throw notFound(`machine ${machineCode}`);
      const active = this.db
        .prepare("SELECT * FROM installations WHERE edge_id = ? AND removed_at IS NULL")
        .get(edge.id) as any;
      if (active) {
        throw new AppError(
          "EDGE_IN_USE",
          `edge ${toolSerial}#${edgeNo} is already installed on machine ${active.machine_id}`,
          409
        );
      }
      this.db
        .prepare("INSERT INTO installations (edge_id, machine_id, installed_at) VALUES (?, ?, ?)")
        .run(edge.id, machine.id, at);
      return { edgeId: edge.id, machineId: machine.id, installedAt: at };
    });
    return tx();
  }

  removeEdge(toolSerial: string, edgeNo: number, ts?: number) {
    const at = ts ?? this.clock.now();
    const tx = this.db.transaction(() => {
      const edge = this.findEdge(toolSerial, edgeNo);
      const active = this.db
        .prepare("SELECT * FROM installations WHERE edge_id = ? AND removed_at IS NULL")
        .get(edge.id) as any;
      if (!active) throw new AppError("EDGE_NOT_INSTALLED", `edge ${toolSerial}#${edgeNo} is not installed`, 409);
      if (at < active.installed_at)
        throw new AppError("VALIDATION_ERROR", "removal ts precedes install ts", 422);
      this.db.prepare("UPDATE installations SET removed_at = ? WHERE id = ?").run(at, active.id);
      return { edgeId: edge.id, removedAt: at };
    });
    return tx();
  }

  private findEdge(toolSerial: string, edgeNo: number) {
    const edge = this.db
      .prepare(
        `SELECT te.* FROM tool_edges te JOIN tools t ON t.id = te.tool_id
         WHERE t.serial = ? AND te.edge_no = ?`
      )
      .get(toolSerial, edgeNo) as any;
    if (!edge) throw notFound(`edge ${toolSerial}#${edgeNo}`);
    return edge;
  }

  /**
   * Ingest one raw event. Idempotent on eventId; raw rows are append-only.
   * Returns { stored: boolean } — false when the event was already seen.
   */
  ingest(ev: MachineEvent): { stored: boolean } {
    const tx = this.db.transaction(() => {
      const machine = this.db.prepare("SELECT * FROM machines WHERE code = ?").get(ev.machineCode) as any;
      if (!machine) throw notFound(`machine ${ev.machineCode}`);
      const dup = this.db.prepare("SELECT id FROM events WHERE event_id = ?").get(ev.eventId);
      if (dup) return false;
      this.db
        .prepare(
          "INSERT INTO events (event_id, machine_id, type, ts, seq, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          ev.eventId,
          machine.id,
          ev.type,
          ev.ts,
          ev.seq ?? 0,
          JSON.stringify(ev.payload ?? {}),
          this.clock.now()
        );
      if (ev.type === "cutting_start" || ev.type === "cutting_stop") {
        this.reconcileMachine(machine.id);
      }
      return true;
    });
    return { stored: tx() };
  }

  ingestBatch(events: MachineEvent[]): { stored: number; duplicates: number } {
    let stored = 0;
    let duplicates = 0;
    for (const ev of events) {
      if (this.ingest(ev).stored) stored++;
      else duplicates++;
    }
    return { stored, duplicates };
  }

  /**
   * Re-derive cutting segments for one machine from its raw events.
   * Idempotent (segments are keyed by the start event id) and safe to run
   * after every ingest, so out-of-order delivery, duplicates and restarts
   * all converge to the same segments. A new cutting_start closes the
   * previous pending one (interrupted cut), so overlapping intervals can
   * never be counted twice.
   */
  private reconcileMachine(machineId: number) {
    const evts = this.db
      .prepare(
        `SELECT * FROM events WHERE machine_id = ? AND type IN ('cutting_start','cutting_stop')
         ORDER BY ts ASC, seq ASC, id ASC`
      )
      .all(machineId) as any[];
    let pending: any = null;
    for (const e of evts) {
      if (e.type === "cutting_start") {
        if (pending) this.closeSegment(machineId, pending, e.ts);
        pending = e;
      } else if (pending) {
        this.closeSegment(machineId, pending, e.ts);
        pending = null;
      }
    }
  }

  /**
   * Create one cutting segment for a start event. The segment is attributed
   * to the edge installed at the segment start and clamped at that edge's
   * removal time, so a cut spanning a tool change only counts against the
   * edge that actually started it.
   */
  private closeSegment(machineId: number, start: any, endTs: number) {
    const startTs = start.ts;
    if (endTs <= startTs) return; // clock skew: wait for a later stop
    const inst = this.db
      .prepare(
        `SELECT * FROM installations
         WHERE machine_id = ? AND installed_at <= ? AND (removed_at IS NULL OR removed_at > ?)
         ORDER BY installed_at DESC LIMIT 1`
      )
      .get(machineId, startTs, startTs) as any;
    if (!inst) return; // no edge installed at start; cannot attribute

    const effectiveEnd = inst.removed_at !== null && inst.removed_at < endTs ? inst.removed_at : endTs;
    if (effectiveEnd <= startTs) return;

    const payload = JSON.parse(start.payload || "{}");
    let programId: number | null = null;
    let workorderId: number | null = null;
    if (payload.workorder) {
      const wo = this.db
        .prepare("SELECT id, program_id FROM workorders WHERE code = ?")
        .get(String(payload.workorder)) as any;
      if (wo) {
        workorderId = wo.id;
        programId = wo.program_id;
      }
    }
    if (!programId && payload.programCode && payload.programVersion) {
      const p = this.db
        .prepare("SELECT id FROM programs WHERE code = ? AND version = ?")
        .get(String(payload.programCode), String(payload.programVersion)) as any;
      if (p) programId = p.id;
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO cutting_segments
           (machine_id, edge_id, program_id, workorder_id, start_ts, end_ts, seconds, source_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        machineId,
        inst.edge_id,
        programId,
        workorderId,
        startTs,
        effectiveEnd,
        (effectiveEnd - startTs) / 1000,
        start.event_id
      );
  }

  /** Life usage per edge of a tool, with remaining life and status. */
  toolLife(toolSerial: string) {
    const tool = this.db.prepare("SELECT * FROM tools WHERE serial = ?").get(toolSerial) as any;
    if (!tool) throw notFound(`tool ${toolSerial}`);
    const edges = this.db
      .prepare(
        `SELECT te.id, te.edge_no, te.life_limit_sec, te.status,
                COALESCE((SELECT SUM(s.seconds) FROM cutting_segments s WHERE s.edge_id = te.id), 0) AS used_sec
         FROM tool_edges te WHERE te.tool_id = ? ORDER BY te.edge_no`
      )
      .all(tool.id) as any[];
    return {
      tool: { serial: tool.serial, name: tool.name },
      edges: edges.map((e) => {
        const remaining = e.life_limit_sec - e.used_sec;
        if (remaining < 0 && e.status === "active") {
          this.raiseAlert(
            "life_exceeded",
            `edge ${toolSerial}#${e.edge_no} exceeded life limit`,
            { toolSerial, edgeNo: e.edge_no, usedSec: e.used_sec, limitSec: e.life_limit_sec }
          );
        }
        return {
          edgeNo: e.edge_no,
          status: e.status,
          lifeLimitSec: e.life_limit_sec,
          usedSec: Math.round(e.used_sec * 1000) / 1000,
          remainingSec: Math.round(remaining * 1000) / 1000,
          exhausted: remaining <= 0,
        };
      }),
    };
  }

  raiseAlert(type: string, message: string, payload: Record<string, unknown>) {
    // Avoid flooding: only one open alert of the same type+message.
    const existing = this.db
      .prepare("SELECT id FROM alerts WHERE type = ? AND message = ? AND status = 'open'")
      .get(type, message);
    if (existing) return existing;
    const r = this.db
      .prepare("INSERT INTO alerts (type, message, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(type, message, JSON.stringify(payload), this.clock.now());
    return { id: Number(r.lastInsertRowid) };
  }
}
