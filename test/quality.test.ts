import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, seedScenario } from './helpers.ts';
import { recorrectGauge } from '../src/domain/catalog.ts';
import { recordMeasurement, reevaluate, setScrapThreshold } from '../src/domain/quality.ts';

function measure(
  db: ReturnType<typeof setupDb>['db'],
  clock: ReturnType<typeof setupDb>['clock'],
  serial: string,
  value: number,
  at: string,
  opts: { allowExpiredGauge?: boolean } = {}
) {
  return recordMeasurement(db, clock, {
    workOrderCode: 'WO100',
    serial,
    featureKey: 'DIA',
    gaugeCode: 'G1',
    measuredAt: at,
    rawValue: value,
    allowExpiredGauge: opts.allowExpiredGauge,
  });
}

test('chronic drift: suspect window spans only since last passing part', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  measure(db, clock, 'S1', 10.0, '2026-01-02T08:00:00Z');
  measure(db, clock, 'S2', 10.02, '2026-01-02T08:10:00Z');
  measure(db, clock, 'S3', 10.05, '2026-01-02T08:20:00Z');
  measure(db, clock, 'S4', 10.0, '2026-01-02T08:30:00Z'); // last passing
  measure(db, clock, 'S5', 10.09, '2026-01-02T08:40:00Z'); // still passing, last good
  measure(db, clock, 'S6', 10.12, '2026-01-02T08:50:00Z'); // fail (usl 10.10)

  const batch = db
    .prepare(
      `SELECT * FROM trace_batches WHERE superseded=0 ORDER BY id DESC LIMIT 1`
    )
    .get() as { from_serial: string; to_serial: string; confidence: string };
  assert.equal(batch.from_serial, 'S6');
  assert.equal(batch.to_serial, 'S6');
});

test('rework-band failure is reinspect-only; gross break is confirmed bad', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  measure(db, clock, 'S1', 10.0, '2026-01-02T08:00:00Z');
  measure(db, clock, 'S2', 10.12, '2026-01-02T08:10:00Z'); // 0.02 over; band 0.1*0.5=0.05 -> rework
  let batch = db
    .prepare('SELECT confidence FROM trace_batches ORDER BY id DESC LIMIT 1')
    .get() as { confidence: string };
  assert.equal(batch.confidence, 'reinspect');

  measure(db, clock, 'S3', 10.3, '2026-01-02T08:20:00Z'); // 0.20 over > 0.05 -> scrap/confirmed
  batch = db.prepare('SELECT confidence FROM trace_batches ORDER BY id DESC LIMIT 1').get() as {
    confidence: string;
  };
  assert.equal(batch.confidence, 'confirmed_bad');
  const dispo = db
    .prepare(`SELECT kind FROM dispositions WHERE serial='S3' AND kind='scrap'`)
    .get();
  assert.ok(dispo);
});

test('expired gauge is rejected, and forced expired reading only triggers reinspect', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock); // gauge valid 1 day
  db.prepare("UPDATE gauges SET calibration_interval_ms=86400000 WHERE code='G1'").run();
  assert.throws(
    () => measure(db, clock, 'S1', 10.5, '2026-01-03T00:00:01Z'),
    /GAUGE_CALIBRATION_EXPIRED|calibration expired/
  );
  const result = measure(db, clock, 'S1', 10.5, '2026-01-03T00:00:01Z', {
    allowExpiredGauge: true,
  });
  assert.equal(result.gaugeExpired, true);
  const batch = db
    .prepare('SELECT confidence FROM trace_batches ORDER BY id DESC LIMIT 1')
    .get() as { confidence: string };
  assert.equal(batch.confidence, 'reinspect');
});

test('calibration correction re-evaluates but preserves the old verdict rows', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  // Gauge reads +0.05 high relative to truth. S1 reads 10.12 (true 10.07) -> judged fail.
  const first = measure(db, clock, 'S1', 10.12, '2026-01-02T08:00:00Z');
  assert.equal(first.verdict, 'fail');

  recorrectGauge(db, clock, {
    code: 'G1',
    calibratedAt: '2026-01-01T20:00:00Z',
    bias: 0.05,
  });
  const n = reevaluate(db, clock, { reason: 'gauge bias corrected' });
  assert.equal(n, 1);

  const old = db.prepare('SELECT * FROM measurements WHERE id=?').get(first.measurementId) as {
    verdict: string;
    superseded: number;
    corrected_value: number;
  };
  assert.equal(old.verdict, 'fail');
  assert.equal(old.superseded, 1);

  const fresh = db
    .prepare('SELECT * FROM measurements WHERE superseded=0')
    .get() as { verdict: string; corrected_value: number };
  assert.ok(Math.abs(fresh.corrected_value - 10.07) < 1e-9);
  assert.equal(fresh.verdict, 'ok');
});

test('scrap threshold change re-evaluates dispositions, old decision retained', () => {
  const { db, clock } = setupDb();
  seedScenario(db, clock);
  measure(db, clock, 'S1', 10.0, '2026-01-02T08:00:00Z');
  measure(db, clock, 'S2', 10.12, '2026-01-02T08:10:00Z'); // 0.02 over
  const firstBatch = db
    .prepare('SELECT id, confidence FROM trace_batches ORDER BY id DESC LIMIT 1')
    .get() as { id: number; confidence: string };
  assert.equal(firstBatch.confidence, 'reinspect');

  // Tighten scrap band: ratio 0.05 of the 0.20 band = 0.01 -> 0.02 over is scrap.
  setScrapThreshold(db, clock, { workOrderCode: 'WO100', featureKey: 'DIA', scrapBandRatio: 0.05 });
  reevaluate(db, clock, { reason: 'scrap threshold tightened' });

  const newBatch = db
    .prepare('SELECT confidence FROM trace_batches WHERE superseded=0 ORDER BY id DESC LIMIT 1')
    .get() as { confidence: string };
  assert.equal(newBatch.confidence, 'confirmed_bad');
  const retained = db.prepare('SELECT superseded FROM trace_batches WHERE id=?').get(firstBatch.id) as {
    superseded: number;
  };
  assert.equal(retained.superseded, 1);
});
