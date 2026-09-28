import * as fs from "fs";
import { openDb } from "./db";
import { FixedClock } from "./clock";
import { makeServices } from "./app";
import { generateScenario } from "./generator";

/**
 * Repeatable end-to-end demo on a fresh fictional database.
 * Deterministic: fixed seed, fixed clock. Safe to re-run (db is deleted).
 */
const DB = "demo.db";
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB + suffix); } catch {}
}

const T0 = 1_700_000_000_000;
const clock = new FixedClock(T0);
const db = openDb(DB);
const { core, events, quality } = makeServices(db, clock);
const show = (title: string, x: unknown) => {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(x, null, 2));
};

// 1. Master data
core.createMachine("MC-01", "Fictional Mill 1");
core.createTool("TOOL-001", "EndMill-10mm", 2, 600); // 2 edges, 600 s life each
core.createGauge("GAUGE-1", 30, T0);
core.createWorkorder("WO-1001", "PART-XYZ", "PROG-A", "v1", 10);
show("master data", { machines: 1, tools: 1, edges: 2, workorder: "WO-1001" });

// 2. Install edge 1 and run 5 pieces (with duplicates + shuffled delivery)
events.installEdge("TOOL-001", 1, "MC-01", T0);
const part1 = generateScenario({ seed: 7, startTs: T0 + 1000, pieces: 5, cutSec: 100, duplicateEvery: 2, shuffle: true });
show("ingest part 1 (dupes + shuffled)", events.ingestBatch(part1.events));
for (const m of part1.measurements) quality.recordMeasurement(m);
show("life after 5x100s", events.toolLife("TOOL-001").edges);

// 3. Tool change to edge 2, then drift + a broken edge on piece 8
events.removeEdge("TOOL-001", 1, T0 + 700_000);
events.installEdge("TOOL-001", 2, "MC-01", T0 + 700_100);
const part2 = generateScenario({
  seed: 8,
  startTs: T0 + 701_000,
  pieces: 5,
  cutSec: 100,
  driftPerPiece: 0.004,
  breakAtPiece: 4,
});
part2.measurements.forEach((m, i) => {
  m.measurementId = `ms-b${i}`;
  m.workpieceSn = `WP-B${i}`;
});
show("ingest part 2", events.ingestBatch(part2.events));
for (const m of part2.measurements) quality.recordMeasurement(m);
show("life after part 2", events.toolLife("TOOL-001").edges);
show("alerts (drift / out-of-tol)", db.prepare("SELECT id, type, message FROM alerts").all());
show("suspect batch", db.prepare("SELECT * FROM suspect_batches").all());
show(
  "suspect items",
  db.prepare("SELECT workpiece_sn, classification, reason FROM suspect_items").all()
);

// 4. Scrap the confirmed-bad piece, rework another
quality.recordQualityAction("qa-1", "WO-1001", "WP-B3", "scrap", "edge broke, out of tolerance");
quality.recordQualityAction("qa-2", "WO-1001", "WP-B2", "rework", "drift suspect");

// 5. Export traceability report
const report = quality.traceabilityReport("WO-1001");
fs.writeFileSync("demo-report.json", JSON.stringify(report, null, 2));
console.log("\nDemo complete. Report exported to demo-report.json (db: demo.db)");
db.close();
