import * as fs from "fs";
import { SeededRng } from "./clock";
import type { MachineEvent } from "./domain/events";
import type { MeasurementInput } from "./domain/quality";

export interface ScenarioOptions {
  seed?: number;
  startTs?: number;
  machineCode?: string;
  workorderCode?: string;
  programCode?: string;
  programVersion?: string;
  pieces?: number;
  cutSec?: number;
  /** inject a duplicate of every Nth event to exercise idempotency */
  duplicateEvery?: number;
  /** shuffle output to exercise out-of-order ingestion */
  shuffle?: boolean;
  /** gradual measurement drift per piece (mm) */
  driftPerPiece?: number;
  /** piece index at which the edge "breaks" (sudden big offset) */
  breakAtPiece?: number;
}

export interface Scenario {
  events: MachineEvent[];
  measurements: MeasurementInput[];
}

/**
 * Pure fictional data generator. Fully deterministic for a given seed:
 * no wall-clock, no real randomness, no machine connection.
 */
export function generateScenario(opts: ScenarioOptions = {}): Scenario {
  const rng = new SeededRng(opts.seed ?? 42);
  const t0 = opts.startTs ?? 1_700_000_000_000;
  const machine = opts.machineCode ?? "MC-01";
  const workorder = opts.workorderCode ?? "WO-1001";
  const pieces = opts.pieces ?? 10;
  const cutSec = opts.cutSec ?? 120;
  const drift = opts.driftPerPiece ?? 0;
  const events: MachineEvent[] = [];
  const measurements: MeasurementInput[] = [];
  let ts = t0;
  let n = 0;

  for (let i = 1; i <= pieces; i++) {
    const jitter = Math.floor(rng.next() * 5000);
    events.push({
      eventId: `ev-${n++}`,
      machineCode: machine,
      type: "cutting_start",
      ts,
      seq: n,
      payload: { workorder, programCode: opts.programCode ?? "PROG-A", programVersion: opts.programVersion ?? "v1" },
    });
    ts += cutSec * 1000;
    events.push({
      eventId: `ev-${n++}`,
      machineCode: machine,
      type: "cutting_stop",
      ts,
      seq: n,
      payload: { workpieceSn: `WP-${i}` },
    });
    ts += 30_000 + jitter; // unload/load gap

    let offset = drift * i + (rng.next() - 0.5) * 0.004;
    if (opts.breakAtPiece !== undefined && i >= opts.breakAtPiece) offset += 0.05;
    measurements.push({
      measurementId: `ms-${i}`,
      workorderCode: workorder,
      workpieceSn: `WP-${i}`,
      feature: "diameter",
      value: Number((10 + offset).toFixed(4)),
      nominal: 10,
      tolPlus: 0.02,
      tolMinus: 0.02,
      gaugeCode: "GAUGE-1",
      measuredAt: ts,
    });
  }

  if (opts.duplicateEvery && opts.duplicateEvery > 0) {
    const withDups: MachineEvent[] = [];
    events.forEach((e, i) => {
      withDups.push(e);
      if (i % opts.duplicateEvery! === 0) withDups.push({ ...e });
    });
    events.length = 0;
    events.push(...withDups);
  }

  if (opts.shuffle) {
    for (let i = events.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }
  }

  return { events, measurements };
}

// CLI entry: npm run generate -- <outFile> [pieces] [seed]
if (require.main === module) {
  const out = process.argv[2] || "events.json";
  const pieces = Number(process.argv[3] || 10);
  const seed = Number(process.argv[4] || 42);
  const scenario = generateScenario({ pieces, seed, duplicateEvery: 3 });
  fs.writeFileSync(out, JSON.stringify(scenario.events, null, 2));
  console.log(`wrote ${scenario.events.length} fictional events to ${out}`);
}
