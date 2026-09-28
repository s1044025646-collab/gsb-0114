import express, { Express, NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { DB } from "./db";
import { Clock } from "./clock";
import { CoreService } from "./domain/core";
import { EventService } from "./domain/events";
import { QualityService } from "./domain/quality";
import { AppError } from "./errors";

export interface Services {
  core: CoreService;
  events: EventService;
  quality: QualityService;
}

export function makeServices(db: DB, clock: Clock): Services {
  const core = new CoreService(db, clock);
  const events = new EventService(db, clock);
  const quality = new QualityService(db, clock, core, events);
  return { core, events, quality };
}

const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function paginate(db: DB, baseSql: string, countSql: string, params: any[], q: any) {
  const p = page.parse(q);
  const total = (db.prepare(countSql).get(...params) as any).n;
  const rows = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(...params, p.limit, p.offset);
  return { data: rows, page: { limit: p.limit, offset: p.offset, total } };
}

const param = (req: Request, key: string): string => String((req.params as any)[key]);

export function createApp(db: DB, clock: Clock): Express {
  const { core, events, quality } = makeServices(db, clock);
  const app = express();
  app.use(express.json());

  const handle =
    (fn: (req: Request, res: Response) => unknown, status = 200) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = fn(req, res);
        res.status(status).json(out ?? { ok: true });
      } catch (e) {
        next(e);
      }
    };

  app.get("/health", (_req, res) => res.json({ ok: true, now: clock.now() }));

  // --- Machines / tools / programs / workorders -------------------------
  app.post(
    "/machines",
    handle((req) => {
      const b = z.object({ code: z.string().min(1), name: z.string().min(1) }).parse(req.body);
      return core.createMachine(b.code, b.name);
    }, 201)
  );
  app.get("/machines", handle((req) => paginate(db, "SELECT * FROM machines ORDER BY id", "SELECT COUNT(*) n FROM machines", [], req.query)));

  app.post(
    "/tools",
    handle((req) => {
      const b = z
        .object({
          serial: z.string().min(1),
          name: z.string().min(1),
          edgeCount: z.number().int().min(1).max(64),
          lifeLimitSec: z.number().positive(),
        })
        .parse(req.body);
      return core.createTool(b.serial, b.name, b.edgeCount, b.lifeLimitSec);
    }, 201)
  );
  app.get("/tools", handle((req) => paginate(db, "SELECT * FROM tools ORDER BY id", "SELECT COUNT(*) n FROM tools", [], req.query)));
  app.get("/tools/:serial/edges", handle((req) => ({ data: core.listEdges(param(req, "serial")) })));
  app.get("/tools/:serial/life", handle((req) => events.toolLife(param(req, "serial"))));

  app.post(
    "/programs",
    handle((req) => {
      const b = z.object({ code: z.string().min(1), version: z.string().min(1) }).parse(req.body);
      return core.registerProgram(b.code, b.version);
    }, 201)
  );

  app.post(
    "/workorders",
    handle((req) => {
      const b = z
        .object({
          code: z.string().min(1),
          partNo: z.string().min(1),
          programCode: z.string().min(1),
          programVersion: z.string().min(1),
          qtyTarget: z.number().int().positive(),
        })
        .parse(req.body);
      return core.createWorkorder(b.code, b.partNo, b.programCode, b.programVersion, b.qtyTarget);
    }, 201)
  );
  app.get("/workorders", handle((req) => paginate(db, "SELECT * FROM workorders ORDER BY id", "SELECT COUNT(*) n FROM workorders", [], req.query)));
  app.get("/workorders/:code", handle((req) => core.getWorkorder(param(req, "code"))));
  app.get("/workorders/:code/traceability", handle((req) => quality.traceabilityReport(param(req, "code"))));

  // --- Tool changes -------------------------------------------------------
  app.post(
    "/tool-changes/install",
    handle((req) => {
      const b = z
        .object({
          toolSerial: z.string().min(1),
          edgeNo: z.number().int().positive(),
          machineCode: z.string().min(1),
          ts: z.number().optional(),
        })
        .parse(req.body);
      return events.installEdge(b.toolSerial, b.edgeNo, b.machineCode, b.ts);
    }, 201)
  );
  app.post(
    "/tool-changes/remove",
    handle((req) => {
      const b = z
        .object({ toolSerial: z.string().min(1), edgeNo: z.number().int().positive(), ts: z.number().optional() })
        .parse(req.body);
      return events.removeEdge(b.toolSerial, b.edgeNo, b.ts);
    })
  );

  // --- Machine events -----------------------------------------------------
  const eventSchema = z.object({
    eventId: z.string().min(1),
    machineCode: z.string().min(1),
    type: z.enum(["cutting_start", "cutting_stop", "tool_install", "tool_remove"]),
    ts: z.number(),
    seq: z.number().int().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  });
  app.post(
    "/events",
    handle((req) => {
      const b = z.union([eventSchema, z.array(eventSchema).min(1)]).parse(req.body);
      if (Array.isArray(b)) return events.ingestBatch(b as any);
      return events.ingest(b as any);
    }, 201)
  );
  app.get(
    "/events",
    handle((req) => {
      const machine = req.query.machine ? String(req.query.machine) : null;
      if (machine) {
        return paginate(
          db,
          "SELECT e.* FROM events e JOIN machines m ON m.id = e.machine_id WHERE m.code = ? ORDER BY e.ts, e.seq, e.id",
          "SELECT COUNT(*) n FROM events e JOIN machines m ON m.id = e.machine_id WHERE m.code = ?",
          [machine],
          req.query
        );
      }
      return paginate(db, "SELECT * FROM events ORDER BY id", "SELECT COUNT(*) n FROM events", [], req.query);
    })
  );

  // --- Gauges / calibration ----------------------------------------------
  app.post(
    "/gauges",
    handle((req) => {
      const b = z
        .object({ code: z.string().min(1), calIntervalDays: z.number().int().positive(), calibratedAt: z.number().optional() })
        .parse(req.body);
      return core.createGauge(b.code, b.calIntervalDays, b.calibratedAt);
    }, 201)
  );
  app.get("/gauges/:code", handle((req) => core.gaugeStatus(param(req, "code"))));
  app.post(
    "/gauges/:code/calibrations",
    handle((req) => {
      const b = z
        .object({ calibratedAt: z.number(), intervalDays: z.number().int().positive(), note: z.string().default(""), correct: z.boolean().default(false) })
        .parse(req.body);
      if (b.correct) return quality.correctCalibration(param(req, "code"), b.calibratedAt, b.intervalDays, b.note);
      return core.addCalibration(param(req, "code"), b.calibratedAt, b.intervalDays, b.note);
    }, 201)
  );

  // --- Measurements / quality --------------------------------------------
  app.post(
    "/measurements",
    handle((req) => {
      const b = z
        .object({
          measurementId: z.string().min(1),
          workorderCode: z.string().min(1),
          workpieceSn: z.string().min(1),
          feature: z.string().min(1),
          value: z.number(),
          nominal: z.number(),
          tolPlus: z.number().nonnegative(),
          tolMinus: z.number().nonnegative(),
          gaugeCode: z.string().min(1),
          measuredAt: z.number(),
        })
        .parse(req.body);
      return quality.recordMeasurement(b);
    }, 201)
  );
  app.get(
    "/measurements",
    handle((req) => {
      const wo = req.query.workorder ? String(req.query.workorder) : null;
      if (wo) {
        return paginate(
          db,
          `SELECT m.*, (SELECT j.result FROM judgements j WHERE j.measurement_id = m.id AND j.superseded_at IS NULL) AS current_result
           FROM measurements m JOIN workorders w ON w.id = m.workorder_id WHERE w.code = ? ORDER BY m.measured_at, m.id`,
          "SELECT COUNT(*) n FROM measurements m JOIN workorders w ON w.id = m.workorder_id WHERE w.code = ?",
          [wo],
          req.query
        );
      }
      return paginate(db, "SELECT * FROM measurements ORDER BY id", "SELECT COUNT(*) n FROM measurements", [], req.query);
    })
  );

  app.post(
    "/quality-actions",
    handle((req) => {
      const b = z
        .object({
          actionId: z.string().min(1),
          workorderCode: z.string().min(1),
          workpieceSn: z.string().min(1),
          type: z.enum(["scrap", "rework"]),
          reason: z.string().default(""),
        })
        .parse(req.body);
      return quality.recordQualityAction(b.actionId, b.workorderCode, b.workpieceSn, b.type, b.reason);
    }, 201)
  );

  app.post(
    "/settings/scrap-threshold",
    handle((req) => {
      const b = z.object({ ratio: z.number().positive() }).parse(req.body);
      return quality.setScrapThreshold(b.ratio);
    })
  );

  app.get(
    "/suspect-batches",
    handle((req) => {
      const result = paginate(db, "SELECT * FROM suspect_batches ORDER BY id", "SELECT COUNT(*) n FROM suspect_batches", [], req.query);
      const items = db.prepare("SELECT * FROM suspect_items ORDER BY id").all() as any[];
      return {
        ...result,
        data: (result.data as any[]).map((b) => ({ ...b, items: items.filter((i) => i.batch_id === b.id) })),
      };
    })
  );

  app.get("/alerts", handle((req) => paginate(db, "SELECT * FROM alerts ORDER BY id", "SELECT COUNT(*) n FROM alerts", [], req.query)));
  app.post(
    "/alerts/:id/acknowledge",
    handle((req) => {
      const r = db.prepare("UPDATE alerts SET status = 'acknowledged' WHERE id = ?").run(Number(param(req, "id")));
      if (r.changes === 0) throw new AppError("NOT_FOUND", "alert not found", 404);
      return { ok: true };
    })
  );

  app.get(
    "/segments",
    handle((req) => paginate(db, "SELECT * FROM cutting_segments ORDER BY id", "SELECT COUNT(*) n FROM cutting_segments", [], req.query))
  );

  // --- Error handling: stable error codes ---------------------------------
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "invalid request", details: err.issues } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    }
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: String(err?.message ?? err) } });
  });

  return app;
}
