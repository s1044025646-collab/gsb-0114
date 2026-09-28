import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { FixedClock } from '../src/domain/clock.ts';
import { seedScenario, mountT001, setupDb } from './helpers.ts';
import { deriveSegments, ingestEvent, listEdgeLife } from '../src/domain/events.ts';
import { recordMount } from '../src/domain/mounts.ts';

function safeRemove(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      // Windows may keep the file briefly mapped after close; temp files are disposable.
    }
  }
}

test('state survives process-style reopen and migrations stay idempotent', () => {
  const file = join(tmpdir(), `cnc-persist-${process.pid}-${Date.now()}.db`);
  try {
    {
      const db = openDatabase(file);
      migrate(db);
      const clock = new FixedClock('2026-01-01T00:00:00Z');
      seedScenario(db, clock);
      mountT001(db, clock, 'MC1', '2026-01-01T00:00:00Z');
      ingestEvent(db, clock, {
        uid: 's1',
        machineCode: 'MC1',
        type: 'cycle_start',
        occurredAt: '2026-01-01T01:00:00Z',
        payload: { program: 'PRG-A', programVersion: '1.0', workOrderCode: 'WO100' },
      });
      ingestEvent(db, clock, {
        uid: 'e1',
        machineCode: 'MC1',
        type: 'cycle_end',
        occurredAt: '2026-01-01T01:05:00Z',
        payload: { program: 'PRG-A', programVersion: '1.0', workOrderCode: 'WO100' },
      });
      deriveSegments(db, clock, 'MC1');
      db.close();
    }
    {
      const db = openDatabase(file);
      migrate(db); // reopen + re-migrate
      const used = listEdgeLife(db)[0]!.usedMs;
      assert.equal(used, 5 * 60_000);
      const raw = db.prepare('SELECT COUNT(*) AS c FROM machine_events').get() as { c: number };
      assert.equal(raw.c, 2);
      const audit = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number };
      assert.ok(audit.c > 0);
      db.close();
    }
  } finally {
    safeRemove(file);
  }
});

test('concurrent mounts: exactly one transaction wins per edge', async () => {
  const file = join(tmpdir(), `cnc-conc-${process.pid}-${Date.now()}.db`);
  try {
    const setup = openDatabase(file);
    migrate(setup);
    seedScenario(setup, new FixedClock('2026-01-01T00:00:00Z'));
    setup.close();

    // Two independent connections race to mount the same edge with an
    // overlapping open interval. Exactly one may win.
    const dbA = openDatabase(file);
    const dbB = openDatabase(file);
    const clockA = new FixedClock('2026-01-01T00:00:00Z');
    const clockB = new FixedClock('2026-01-01T00:00:00Z');
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        recordMount(dbA, clockA, {
          toolSerial: 'T-001',
          edgeNo: 1,
          machineCode: 'MC1',
          mountedAt: '2026-01-01T00:00:00Z',
        })
      ),
      new Promise<number>((resolveFn, reject) =>
        setTimeout(() => {
          try {
            resolveFn(
              recordMount(dbB, clockB, {
                toolSerial: 'T-001',
                edgeNo: 1,
                machineCode: 'MC2',
                mountedAt: '2026-01-01T00:00:01Z',
              })
            );
          } catch (err) {
            reject(err);
          }
        }, 20)
      ),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;
    assert.equal(fulfilled, 1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    assert.ok(rejected);
    if (rejected?.status === 'rejected')
      assert.match(String((rejected.reason as { code?: string }).code), /EDGE_MOUNT_CONFLICT|SQLITE/);
    dbA.close();
    dbB.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    safeRemove(file);
  }
});



