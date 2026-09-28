import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, seedScenario, mountT001 } from './helpers.ts';
import { deriveSegments, ingestEvent, computeEdgeLife, listEdgeLife } from '../src/domain/events.ts';
import { createTool } from '../src/domain/catalog.ts';
import { recordMount } from '../src/domain/mounts.ts';
import type { Db } from '../src/db/connection.ts';
import type { FixedClock } from '../src/domain/clock.ts';

function cycle(
  db: Db,
  clock: FixedClock,
  uid: string,
  type: 'cycle_start' | 'cycle_end',
  occurredAt: string,
  wo = 'WO100',
  version = '1.0'
): boolean {
  return ingestEvent(db, clock, {
    uid,
    machineCode: 'MC1',
    type,
    occurredAt,
    payload: { program: 'PRG-A', programVersion: version, workOrderCode: wo },
  });
}

test('interrupted cutting: gaps and multiple cycles accumulate exactly', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  cycle(db, clock, 's1', 'cycle_start', '2026-01-01T01:00:00Z');
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T01:05:00Z');
  cycle(db, clock, 's2', 'cycle_start', '2026-01-01T02:00:00Z');
  cycle(db, clock, 'e2', 'cycle_end', '2026-01-01T02:10:00Z');
  deriveSegments(db, clock, 'MC1');
  const life = listEdgeLife(db)[0]!;
  assert.equal(life.usedMs, 15 * 60_000);
  assert.equal(life.remainingMs, 600_000 - 15 * 60_000);
});

test('duplicate event uids are idempotent and do not double life', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  cycle(db, clock, 's1', 'cycle_start', '2026-01-01T01:00:00Z');
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T01:05:00Z');
  assert.equal(cycle(db, clock, 's1', 'cycle_start', '2026-01-01T01:00:00Z'), false);
  deriveSegments(db, clock, 'MC1');
  deriveSegments(db, clock, 'MC1');
  assert.equal(listEdgeLife(db)[0]!.usedMs, 5 * 60_000);
});

test('out-of-order ingestion attributes correctly after later derivation', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  // end arrives first
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T01:05:00Z');
  deriveSegments(db, clock, 'MC1');
  assert.equal(listEdgeLife(db)[0]!.usedMs, 0);
  cycle(db, clock, 's1', 'cycle_start', '2026-01-01T01:00:00Z');
  deriveSegments(db, clock, 'MC1');
  assert.equal(listEdgeLife(db)[0]!.usedMs, 5 * 60_000);
});

test('clock offset canonicalizes event time', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  assert.equal(
    ingestEvent(db, clock, {
      uid: 's1',
      machineCode: 'MC1',
      type: 'cycle_start',
      occurredAt: '2026-01-01T02:00:00Z',
      clockOffsetMs: -3_600_000,
      payload: { program: 'PRG-A', programVersion: '1.0', workOrderCode: 'WO100' },
    }),
    true
  );
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T01:05:00Z');
  deriveSegments(db, clock, 'MC1');
  assert.equal(listEdgeLife(db)[0]!.usedMs, 5 * 60_000);
});

test('cutting across a tool change is clipped at the dismount boundary', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  createTool(db, clock, { serial: 'T-002', lifeLimitMs: 600_000 });
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z', '2026-01-01T01:04:00Z');
  recordMount(db, clock, {
    toolSerial: 'T-002',
    edgeNo: 1,
    machineCode: 'MC1',
    mountedAt: '2026-01-01T01:04:00Z',
  });
  cycle(db, clock, 's1', 'cycle_start', '2026-01-01T01:00:00Z');
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T01:10:00Z');
  const result = deriveSegments(db, clock, 'MC1');
  assert.equal(result.clipped, 1);
  const rows = db.prepare('SELECT edge_id, duration_ms FROM cut_segments ORDER BY edge_id').all() as
    | { edge_id: number; duration_ms: number }[];
  assert.deepEqual(
    rows.map((r) => r.duration_ms),
    [4 * 60_000]
  );
});

test('same edge cannot be mounted on two machines over the same interval', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  assert.throws(
    () => mountT001(db, clock, 'MC2', '2026-01-01T00:30:00Z'),
    /EDGE_MOUNT_CONFLICT|already mounted/
  );
});

test('life expired flag after full-life accumulation', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
  cycle(db, clock, 's1', 'cycle_start', '2026-01-01T00:00:00Z');
  cycle(db, clock, 'e1', 'cycle_end', '2026-01-01T00:11:00Z'); // 660s > 600s limit
  deriveSegments(db, clock, 'MC1');
  const life = computeEdgeLife(db, 1);
  assert.equal(life.usedMs, 660_000);
  assert.equal(life.expired, true);
});
