import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../src/db/connection.ts';
import { FixedClock } from '../src/domain/clock.ts';
import { generateScenario } from '../src/domain/generator.ts';
import { raiseLifeAlerts } from '../src/domain/events.ts';
import { recorrectGauge } from '../src/domain/catalog.ts';
import { reevaluate } from '../src/domain/quality.ts';

const dbFile = resolve(process.cwd(), 'data', 'demo.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true });

const db = openDatabase(dbFile);
migrate(db);
const clock = new FixedClock('2026-02-01T00:00:00Z');

console.log('== generating repeatable fictional scenario (seed=42) ==');
const result = generateScenario(db, clock, {
  parts: 24,
  cycleMs: 60_000,
  driftPerPart: 0.006,
  breakAtPart: 18,
  breakJump: 0.06,
  noiseSigma: 0.002,
  seed: 42,
});
raiseLifeAlerts(db, clock);

console.log('failing parts:', result.failingParts);
console.log('open traces:');
console.log(db.prepare('SELECT from_serial, to_serial, confidence FROM trace_batches WHERE superseded=0 ORDER BY id').all());

console.log('== correcting a fictional gauge bias (0.01) and re-evaluating ==');
recorrectGauge(db, clock, { code: 'G-DEMO', calibratedAt: '2026-02-01T00:00:00Z', bias: 0.01 });
console.log('reevaluated rows:', reevaluate(db, clock, { reason: 'demo correction' }));
console.log(db.prepare('SELECT from_serial, to_serial, confidence FROM trace_batches ORDER BY id').all());
console.log('audit rows:', (db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c);
db.close();
console.log(`demo database retained at ${dbFile}`);
