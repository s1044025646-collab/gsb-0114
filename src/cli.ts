#!/usr/bin/env node
import * as fs from "fs";
import { openDb } from "./db";
import { SystemClock } from "./clock";
import { makeServices } from "./app";

/**
 * CLI talks to the SQLite database file directly (same as the API server).
 * Use --db <path> or DB_PATH to select the database.
 */
const args = process.argv.slice(2);
function opt(name: string, dflt?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const dbPath = opt("db", process.env.DB_PATH || "cnc.db")!;
const db = openDb(dbPath);
const { core, events, quality } = makeServices(db, new SystemClock());

const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const fail = (e: any) => {
  console.error(`ERROR [${e.code ?? "INTERNAL_ERROR"}] ${e.message}`);
  process.exit(1);
};

function edgeStates(serial: string) {
  return core.listEdges(serial).map((e: any) => ({
    edgeNo: e.edge_no,
    status: e.status,
    installedOnMachine: e.machine_id ?? null,
    installedAt: e.installed_at ?? null,
  }));
}

async function main() {
  const [cmd, sub, ...rest] = args.filter(
    (a, i) => !(a.startsWith("--") || (i > 0 && args[i - 1] === "--db"))
  );
  const pos = rest;

  switch (cmd) {
    case "machine": {
      if (sub === "add") print(core.createMachine(pos[0], pos[1] ?? pos[0]));
      else if (sub === "list") print(db.prepare("SELECT * FROM machines").all());
      else usage();
      break;
    }
    case "tool": {
      if (sub === "add") {
        print(core.createTool(pos[0], pos[1], Number(pos[2]), Number(pos[3])));
      } else if (sub === "edges") print(edgeStates(pos[0]));
      else usage();
      break;
    }
    case "gauge": {
      if (sub === "add")
        print(core.createGauge(pos[0], Number(pos[1]), pos[2] ? Number(pos[2]) : undefined));
      else if (sub === "status") print(core.gaugeStatus(pos[0]));
      else if (sub === "calibrate")
        print(core.addCalibration(pos[0], Number(pos[1]), Number(pos[2]), pos[3] ?? ""));
      else if (sub === "correct")
        print(quality.correctCalibration(pos[0], Number(pos[1]), Number(pos[2]), pos[3] ?? "correction"));
      else usage();
      break;
    }
    case "workorder": {
      if (sub === "create") {
        print(core.createWorkorder(pos[0], pos[1], pos[2], pos[3], Number(pos[4])));
      } else if (sub === "show") print(core.getWorkorder(pos[0]));
      else if (sub === "list") print(db.prepare("SELECT * FROM workorders").all());
      else usage();
      break;
    }
    case "event": {
      if (sub === "import") {
        const raw = JSON.parse(fs.readFileSync(pos[0], "utf8"));
        const list = Array.isArray(raw) ? raw : [raw];
        print(events.ingestBatch(list));
      } else if (sub === "add") {
        print(events.ingest(JSON.parse(pos[0])));
      } else if (sub === "list") {
        print(db.prepare("SELECT * FROM events ORDER BY id").all());
      } else usage();
      break;
    }
    case "tool-change": {
      const serial = pos[0];
      if (sub === "install") {
        console.log("BEFORE:");
        print(edgeStates(serial));
        print(events.installEdge(serial, Number(pos[1]), pos[2], pos[3] ? Number(pos[3]) : undefined));
        console.log("AFTER:");
        print(edgeStates(serial));
      } else if (sub === "remove") {
        console.log("BEFORE:");
        print(edgeStates(serial));
        print(events.removeEdge(serial, Number(pos[1]), pos[2] ? Number(pos[2]) : undefined));
        console.log("AFTER:");
        print(edgeStates(serial));
      } else usage();
      break;
    }
    case "measure": {
      const input = JSON.parse(pos[0]);
      console.log("BEFORE:");
      print(core.gaugeStatus(input.gaugeCode));
      print(quality.recordMeasurement(input));
      console.log("AFTER:");
      print(db.prepare("SELECT * FROM alerts WHERE status = 'open'").all());
      break;
    }
    case "life": {
      print(events.toolLife(sub));
      break;
    }
    case "suspects": {
      const batches = db.prepare("SELECT * FROM suspect_batches ORDER BY id").all() as any[];
      const items = db.prepare("SELECT * FROM suspect_items ORDER BY id").all() as any[];
      print(batches.map((b) => ({ ...b, items: items.filter((i) => i.batch_id === b.id) })));
      break;
    }
    case "report": {
      const report = quality.traceabilityReport(sub);
      if (pos[0]) {
        fs.writeFileSync(pos[0], JSON.stringify(report, null, 2));
        console.log(`report written to ${pos[0]}`);
      } else print(report);
      break;
    }
    case "scrap-threshold": {
      print(quality.setScrapThreshold(Number(sub)));
      break;
    }
    case "alerts": {
      print(db.prepare("SELECT * FROM alerts ORDER BY id").all());
      break;
    }
    default:
      usage();
  }
}

function usage() {
  console.log(
    [
      "CNC tool-life & quality tracker CLI (fictional data only)",
      "",
      "Usage: npm run cli -- [--db path] <command>",
      "",
      "  machine add <code> <name> | machine list",
      "  tool add <serial> <name> <edges> <lifeLimitSec> | tool edges <serial>",
      "  gauge add <code> <intervalDays> [calibratedAtEpochMs]",
      "  gauge status <code> | gauge calibrate <code> <at> <days> [note]",
      "  gauge correct <code> <at> <days> [note]   (re-evaluates measurements)",
      "  workorder create <code> <partNo> <progCode> <progVer> <qty>",
      "  workorder show <code> | workorder list",
      "  event import <file.json> | event add '<json>' | event list",
      "  tool-change install <serial> <edgeNo> <machine> [ts]",
      "  tool-change remove  <serial> <edgeNo> [ts]",
      "  measure '<json>'                        register a measurement",
      "  life <toolSerial>                       remaining life per edge",
      "  suspects                                list suspect batches",
      "  report <workorderCode> [outFile]        export traceability report",
      "  scrap-threshold <ratio>                 update threshold + re-evaluate",
      "  alerts                                  list alerts",
    ].join("\n")
  );
  process.exit(1);
}

main()
  .catch(fail)
  .finally(() => db.close());
