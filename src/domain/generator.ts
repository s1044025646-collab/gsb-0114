import type { Db } from '../db/connection.ts';
import { createGauge, createMachine, createProgram, createTool, createWorkOrder, addFeature } from './catalog.ts';
import type { Clock } from './clock.ts';
import { ingestEvent, deriveSegments } from './events.ts';
import { recordMount, dismountEdge } from './mounts.ts';
import { recordMeasurement } from './quality.ts';

/** Deterministic PRNG (mulberry32) so demos and tests are repeatable. */
export class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gaussian(): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export interface ScenarioOptions {
  machineCode?: string;
  toolSerial?: string;
  workOrder?: string;
  parts?: number;
  cycleMs?: number;
  /** Slow linear drift of diameter per part (e.g. +0.004). */
  driftPerPart?: number;
  /** Part index (1-based) at which the edge suddenly breaks and jumps. */
  breakAtPart?: number;
  breakJump?: number;
  /** Random measurement noise sigma. */
  noiseSigma?: number;
  seed?: number;
  /** Change the tool edge at this part index (exclusive boundary). */
  changeEdgeAtPart?: number;
}

/**
 * Generate a fully fictional end-to-end scenario:
 * machines, tools/edges, programs, work order + feature, gauge, mounts,
 * raw cycle events (with deliberate out-of-order delivery for one cycle),
 * and measurements showing either chronic drift or a sudden break.
 */
export function generateScenario(db: Db, clock: Clock, opts: ScenarioOptions = {}): {
  workOrder: string;
  failingParts: string[];
} {
  const machineCode = opts.machineCode ?? 'MC-DEMO';
  const toolSerial = opts.toolSerial ?? 'T-DEMO';
  const workOrder = opts.workOrder ?? 'WO-DEMO';
  const parts = opts.parts ?? 24;
  const cycleMs = opts.cycleMs ?? 60_000;
  const drift = opts.driftPerPart ?? 0.004;
  const breakAt = opts.breakAtPart ?? 0;
  const breakJump = opts.breakJump ?? 0.08;
  const sigma = opts.noiseSigma ?? 0.003;
  const rnd = new SeededRandom(opts.seed ?? 42);

  createMachine(db, clock, { code: machineCode, name: 'Demo Mill' });
  createTool(db, clock, {
    serial: toolSerial,
    lifeLimitMs: parts * cycleMs * 2,
    edges: 2,
    edgeLifeLimitMs: parts * cycleMs,
  });
  createProgram(db, clock, { name: 'PRG-DEMO', version: '1.0' });
  createWorkOrder(db, clock, { code: workOrder, partNo: 'DEMO-PART', qty: parts });
  addFeature(db, clock, {
    workOrderCode: workOrder,
    key: 'DIA',
    nominal: 10,
    usl: 10.08,
    lsl: 9.92,
  });
  createGauge(db, clock, {
    code: 'G-DEMO',
    featureKey: 'DIA',
    calibrationIntervalMs: 365 * 86_400_000,
    calibratedAt: '2025-12-01T00:00:00Z',
  });

  const start = clock.now();
  recordMount(db, clock, {
    toolSerial,
    edgeNo: 1,
    machineCode,
    mountedAt: start.toISOString(),
  });

  const failingParts: string[] = [];
  let uidSeq = 0;
  const uid = (p: string) => `evt-${p}-${(uidSeq++).toString(36)}`;

  for (let i = 1; i <= parts; i++) {
    const cycleStart = new Date(start.getTime() + (i - 1) * cycleMs);
    const cycleEnd = new Date(cycleStart.getTime() + cycleMs - 500);
    if (opts.changeEdgeAtPart && i === opts.changeEdgeAtPart) {
      const changeAt = cycleStart.toISOString();
      dismountEdge(db, clock, { toolSerial, edgeNo: 1, machineCode, at: changeAt });
      recordMount(db, clock, {
        toolSerial,
        edgeNo: 2,
        machineCode,
        mountedAt: changeAt,
      });
    }

    const sUid = uid('s');
    const eUid = uid('e');
    const payload = { program: 'PRG-DEMO', programVersion: '1.0', workOrderCode: workOrder };
    // Deliver one pair out of order (end before start).
    if (i === 5) {
      ingestEvent(db, clock, { uid: eUid, machineCode, type: 'cycle_end', occurredAt: cycleEnd.toISOString(), payload });
      ingestEvent(db, clock, { uid: sUid, machineCode, type: 'cycle_start', occurredAt: cycleStart.toISOString(), payload });
    } else {
      ingestEvent(db, clock, { uid: sUid, machineCode, type: 'cycle_start', occurredAt: cycleStart.toISOString(), payload });
      ingestEvent(db, clock, { uid: eUid, machineCode, type: 'cycle_end', occurredAt: cycleEnd.toISOString(), payload });
    }

    const measuredAt = new Date(cycleEnd.getTime() + 1000);
    const breakOffset = breakAt && i >= breakAt ? breakJump : 0;
    const value = 10 + drift * (i - 1) + breakOffset + rnd.gaussian() * sigma;
    const serial = `P${String(i).padStart(3, '0')}`;
    const result = recordMeasurement(db, clock, {
      workOrderCode: workOrder,
      serial,
      featureKey: 'DIA',
      gaugeCode: 'G-DEMO',
      measuredAt: measuredAt.toISOString(),
      rawValue: Number(value.toFixed(4)),
    });
    if (result.verdict === 'fail') failingParts.push(serial);
  }

  deriveSegments(db, clock, machineCode);
  return { workOrder, failingParts };
}
