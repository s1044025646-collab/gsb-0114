#!/usr/bin/env node
import { resolve } from 'node:path';
import { migrate, openDatabase } from '../db/connection.ts';
import { SystemClock } from '../domain/clock.ts';
import {
  addFeature,
  createGauge,
  createMachine,
  createProgram,
  createTool,
  createWorkOrder,
  listMachines,
  listTools,
  recorrectGauge,
} from '../domain/catalog.ts';
import { recordMount, dismountEdge } from '../domain/mounts.ts';
import { deriveSegments, ingestEvent, listEdgeLife, raiseLifeAlerts } from '../domain/events.ts';
import { recordMeasurement, reevaluate, setScrapThreshold } from '../domain/quality.ts';
import { generateScenario } from '../domain/generator.ts';
import { AppError } from '../domain/errors.ts';

const dbPath = process.env.CNC_DB_PATH ?? resolve(process.cwd(), 'data', 'cnc.db');
const db = openDatabase(dbPath);
migrate(db);
const clock = new SystemClock();

function usage(): void {
  console.log(`CNC tracking CLI

Usage:
  cnc init-demo
  cnc machine add <code> <name>
  cnc tool add <serial> <lifeLimitMs> [edges] [edgeLifeMs]
  cnc program add <name> <version>
  cnc workorder add <code> <partNo> <qty>
  cnc feature add <woCode> <key> <nominal> <usl> <lsl>
  cnc gauge add <code> <featureKey> <intervalMs> [calibratedAtIso]
  cnc gauge recalibrate <code> <calibratedAtIso> <bias>
  cnc mount <toolSerial> <edgeNo> <machineCode> <mountedAtIso>
  cnc dismount <toolSerial> <edgeNo> <machineCode> <atIso>
  cnc event <uid> <machineCode> <cycle_start|cycle_end> <occurredAtIso> <program> <version> <woCode>
  cnc derive [machineCode]
  cnc measure <woCode> <serial> <featureKey> <gaugeCode> <measuredAtIso> <rawValue>
  cnc life
  cnc life-alerts
  cnc scrap-threshold <woCode> <featureKey> <ratio>
  cnc reevaluate [woCode]
  cnc traces
  cnc report <woCode>
  cnc list machines|tools
`);
}

function print(label: string, value: unknown): void {
  console.log(`-- ${label} --`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function edgeLifeSummary(): void {
  for (const life of listEdgeLife(db)) {
    console.log(
      `${life.toolSerial}#${life.edgeNo}  used=${life.usedMs}ms  remaining=${life.remainingMs}ms ` +
        `(${(life.remainingRatio * 100).toFixed(1)}%)${life.expired ? '  EXPIRED' : ''}`
    );
  }
}

function report(woCode: string): void {
  const measurements = db
    .prepare('SELECT * FROM measurements WHERE work_order_code=? AND superseded=0 ORDER BY measured_at')
    .all(woCode);
  const segments = db
    .prepare('SELECT * FROM cut_segments WHERE work_order_code=? ORDER BY start_at')
    .all(woCode);
  const traces = db
    .prepare('SELECT * FROM trace_batches WHERE work_order_code=? AND superseded=0 ORDER BY id')
    .all(woCode);
  const audits = db
    .prepare('SELECT COUNT(*) AS c FROM audit_log')
    .get() as { c: number };
  console.log(`Quality trace report for ${woCode}`);
  console.log(`measurements: ${measurements.length}, segments: ${segments.length}, open traces: ${traces.length}, audit rows: ${audits.c}`);
  for (const t of traces) console.log('trace', JSON.stringify(t));
  for (const m of measurements) {
    const row = m as { serial: string; feature_key: string; corrected_value: number; verdict: string };
    console.log(`  ${row.serial} ${row.feature_key} = ${row.corrected_value} [${row.verdict}]`);
  }
}

try {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init-demo': {
      const before = listEdgeLife(db).length;
      const result = generateScenario(db, clock, { driftPerPart: 0.006, breakAtPart: 20, breakJump: 0.06 });
      raiseLifeAlerts(db, clock);
      print('before edges', before);
      edgeLifeSummary();
      print('demo result', result);
      break;
    }
    case 'machine':
      if (args[0] === 'add') print('created machine', { id: createMachine(db, clock, { code: args[1]!, name: args.slice(2).join(' ') }) });
      else usage();
      break;
    case 'tool':
      if (args[0] === 'add')
        print('created tool', {
          id: createTool(db, clock, {
            serial: args[1]!,
            lifeLimitMs: Number(args[2]),
            edges: Number(args[3] ?? 1),
            edgeLifeLimitMs: Number(args[4] ?? args[2]),
          }),
        });
      else usage();
      break;
    case 'program':
      print('created program', { id: createProgram(db, clock, { name: args[1]!, version: args[2]! }) });
      break;
    case 'workorder':
      print('created work order', { id: createWorkOrder(db, clock, { code: args[1]!, partNo: args[2]!, qty: Number(args[3]) }) });
      break;
    case 'feature':
      print('created feature', {
        id: addFeature(db, clock, {
          workOrderCode: args[1]!,
          key: args[2]!,
          nominal: Number(args[3]),
          usl: Number(args[4]),
          lsl: Number(args[5]),
        }),
      });
      break;
    case 'gauge':
      if (args[0] === 'add')
        print('created gauge', {
          id: createGauge(db, clock, {
            code: args[1]!,
            featureKey: args[2]!,
            calibrationIntervalMs: Number(args[3]),
            calibratedAt: args[4],
          }),
        });
      else if (args[0] === 'recalibrate')
        print('recalibrated', {
          calibrationId: recorrectGauge(db, clock, { code: args[1]!, calibratedAt: args[2]!, bias: Number(args[3]) }),
        });
      else usage();
      break;
    case 'mount':
      print('created mount', {
        mountId: recordMount(db, clock, {
          toolSerial: args[0]!,
          edgeNo: Number(args[1]),
          machineCode: args[2]!,
          mountedAt: args[3]!,
        }),
      });
      break;
    case 'dismount':
      dismountEdge(db, clock, {
        toolSerial: args[0]!,
        edgeNo: Number(args[1]),
        machineCode: args[2]!,
        at: args[3]!,
      });
      print('dismounted', { ok: true });
      break;
    case 'event': {
      const duplicated = !ingestEvent(db, clock, {
        uid: args[0]!,
        machineCode: args[1]!,
        type: args[2] as 'cycle_start' | 'cycle_end',
        occurredAt: args[3]!,
        payload: { program: args[4], programVersion: args[5], workOrderCode: args[6] },
      });
      print(duplicated ? 'duplicate event ignored' : 'ingested event', { uid: args[0] });
      break;
    }
    case 'derive':
      print('derived segments', deriveSegments(db, clock, args[0]));
      break;
    case 'measure':
      print('measurement', recordMeasurement(db, clock, {
        workOrderCode: args[0]!,
        serial: args[1]!,
        featureKey: args[2]!,
        gaugeCode: args[3]!,
        measuredAt: args[4]!,
        rawValue: Number(args[5]),
      }));
      break;
    case 'life':
      edgeLifeSummary();
      break;
    case 'life-alerts':
      print('raised alerts', { count: raiseLifeAlerts(db, clock) });
      break;
    case 'scrap-threshold':
      setScrapThreshold(db, clock, { workOrderCode: args[0]!, featureKey: args[1]!, scrapBandRatio: Number(args[2]) });
      print('threshold updated', { ok: true });
      break;
    case 'reevaluate':
      print('reevaluated', { count: reevaluate(db, clock, { workOrderCode: args[0], reason: 'manual re-evaluation' }) });
      break;
    case 'traces':
      console.log(db.prepare('SELECT * FROM trace_batches WHERE superseded=0 ORDER BY id').all());
      break;
    case 'report':
      report(args[0]!);
      break;
    case 'list':
      if (args[0] === 'machines') console.log(listMachines(db));
      else if (args[0] === 'tools') console.log(listTools(db));
      else usage();
      break;
    default:
      usage();
  }
} catch (err) {
  if (err instanceof AppError) {
    console.error(`ERROR [${err.code}] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  db.close();
}
