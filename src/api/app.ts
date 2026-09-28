import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Db } from '../db/connection.ts';
import { SystemClock } from '../domain/clock.ts';
import { AppError } from '../domain/errors.ts';
import {
  addFeature,
  createGauge,
  createMachine,
  createProgram,
  createTool,
  createWorkOrder,
  recorrectGauge,
} from '../domain/catalog.ts';
import { recordMount, dismountEdge } from '../domain/mounts.ts';
import { deriveSegments, ingestEvent, listEdgeLife, raiseLifeAlerts } from '../domain/events.ts';
import { recordMeasurement, reevaluate, setScrapThreshold } from '../domain/quality.ts';
import { paginate, parsePage } from './pagination.ts';

type Json = Record<string, unknown>;

const TABLES_FOR_LIST: Record<string, string> = {
  machines: 'machines',
  tools: 'tools',
  programs: 'programs',
  work_orders: 'work_orders',
  events: 'machine_events',
  measurements: 'measurements',
  mounts: 'tool_mounts',
  segments: 'cut_segments',
  alerts: 'alerts',
  dispositions: 'dispositions',
  traces: 'trace_batches',
  audit: 'audit_log',
};

export interface AppDeps {
  db: Db;
}

export async function handleRequest(
  deps: AppDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const clock = new SystemClock();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams);

    if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });

    if (req.method === 'POST' && path === '/machines')
      return send(res, 201, { id: createMachine(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/tools')
      return send(res, 201, { id: createTool(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/programs')
      return send(res, 201, { id: createProgram(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/work-orders')
      return send(res, 201, { id: createWorkOrder(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/features')
      return send(res, 201, { id: addFeature(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/gauges')
      return send(res, 201, { id: createGauge(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/gauges/recalibrate')
      return send(res, 200, { calibrationId: recorrectGauge(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/mounts')
      return send(res, 201, { mountId: recordMount(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/mounts/dismount') {
      dismountEdge(deps.db, clock, (await readBody(req)) as never);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/events') {
      const created = ingestEvent(deps.db, clock, (await readBody(req)) as never);
      return send(res, created ? 201 : 200, { duplicated: !created });
    }
    if (req.method === 'POST' && path === '/events/derive') {
      const body = (await readBody(req)) as { machineCode?: string };
      return send(res, 200, deriveSegments(deps.db, clock, body?.machineCode));
    }
    if (req.method === 'POST' && path === '/measurements')
      return send(res, 201, recordMeasurement(deps.db, clock, (await readBody(req)) as never));
    if (req.method === 'POST' && path === '/reevaluate')
      return send(res, 200, { reevaluated: reevaluate(deps.db, clock, (await readBody(req)) as never) });
    if (req.method === 'POST' && path === '/scrap-threshold') {
      setScrapThreshold(deps.db, clock, (await readBody(req)) as never);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/life/alerts')
      return send(res, 200, { raised: raiseLifeAlerts(deps.db, clock) });
    if (req.method === 'GET' && path === '/life')
      return send(res, 200, { edges: listEdgeLife(deps.db) });

    const listMatch = /^\/(machines|tools|programs|work_orders|events|measurements|mounts|segments|alerts|dispositions|traces|audit)$/.exec(path);
    if (req.method === 'GET' && listMatch) {
      const table = TABLES_FOR_LIST[listMatch[1]!]!;
      const page = parsePage(query);
      const where: string[] = [];
      const params: unknown[] = [];
      for (const key of ['machine_code', 'work_order_code', 'feature_key', 'serial', 'gauge_code', 'superseded']) {
        if (typeof query[key] === 'string') {
          where.push(`${key} = ?`);
          params.push(query[key]);
        }
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = deps.db
        .prepare(`SELECT * FROM ${table} ${whereSql} ORDER BY id LIMIT ? OFFSET ?`)
        .all(...(params as never[]), page.limit, page.offset) as unknown[];
      return send(res, 200, paginate(rows, page));
    }

    return send(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${path}` } });
  } catch (err) {
    return sendError(res, err);
  }
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new AppError('VALIDATION_ERROR', 'request body must be a JSON object');
    return parsed as Json;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('VALIDATION_ERROR', 'invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION_ERROR'
          ? 400
          : err.code === 'DUPLICATE_EVENT' || err.code === 'CONFLICT' || err.code === 'EDGE_MOUNT_CONFLICT'
            ? 409
            : err.code === 'GAUGE_CALIBRATION_EXPIRED'
              ? 422
              : 400;
    send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
    return send(res, 409, { error: { code: 'CONFLICT', message: err.message } });
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  send(res, 500, { error: { code: 'INTERNAL', message } });
}
