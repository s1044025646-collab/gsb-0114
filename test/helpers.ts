import { openDatabase, migrate, type Db } from '../src/db/connection.ts';
import { FixedClock } from '../src/domain/clock.ts';
import { createMachine, createProgram, createTool, createWorkOrder, addFeature, createGauge } from '../src/domain/catalog.ts';
import { recordMount } from '../src/domain/mounts.ts';

export interface Harness {
  db: Db;
  clock: FixedClock;
}

export function setupDb(start = '2026-01-01T00:00:00Z'): Harness {
  const db = openDatabase(':memory:');
  migrate(db);
  const clock = new FixedClock(start);
  return { db, clock };
}

export function seedScenario(db: Db, clock: FixedClock): void {
  createMachine(db, clock, { code: 'MC1', name: 'Mill 1' });
  createMachine(db, clock, { code: 'MC2', name: 'Mill 2' });
  createTool(db, clock, { serial: 'T-001', lifeLimitMs: 600_000, edges: 1, edgeLifeLimitMs: 600_000 });
  createProgram(db, clock, { name: 'PRG-A', version: '1.0' });
  createProgram(db, clock, { name: 'PRG-A', version: '1.1' });
  createWorkOrder(db, clock, { code: 'WO100', partNo: 'P-77', qty: 100 });
  addFeature(db, clock, { workOrderCode: 'WO100', key: 'DIA', nominal: 10, usl: 10.1, lsl: 9.9 });
  createGauge(db, clock, {
    code: 'G1',
    featureKey: 'DIA',
    calibrationIntervalMs: 30 * 86_400_000,
    calibratedAt: '2026-01-01T00:00:00Z',
  });
}

export function mountT001(
  db: Db,
  clock: FixedClock,
  machine: string,
  mountedAt: string,
  dismountedAt?: string
): number {
  return recordMount(db, clock, {
    toolSerial: 'T-001',
    edgeNo: 1,
    machineCode: machine,
    mountedAt,
    dismountedAt,
  });
}
