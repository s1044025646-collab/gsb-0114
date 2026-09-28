# CNC Tool Life & Workpiece Quality Tracking Backend

A local, Windows-runnable backend (TypeScript + Node.js + built-in `node:sqlite`)
for tracking CNC tool edge life and workpiece quality. It exposes an HTTP API,
a CLI, a fictional machine-event generator, repeatable demos and automated
tests. There is no web UI and no connection to real machines; all data is
fictional.

## Requirements

- Node.js >= 22 (tested on Node 25, which ships `node:sqlite`).
- No native compilation and no external database server are needed.

## Install

```powershell
npm install
```

## Test

```powershell
npm test
npm run typecheck
```

Tests run fully in-memory / temp files with injected clocks and a seeded PRNG,
so they are deterministic and never wait on real time. They cover:

- interrupted / repeated / out-of-order cutting events and clock offset,
- tool-change boundary clipping and no double accrual,
- chronic drift vs. sudden edge break, expired-gauge handling,
- suspect-batch trace windows (re-inspect vs. confirmed bad),
- calibration / scrap-threshold correction with old verdicts retained,
- concurrent mount exclusion, audit trail and persistence across reopen.

## Start / stop the API

```powershell
# Port 0 = the OS assigns a free local port; it is printed at startup.
npm start
# or pin one:
$env:PORT="8080"; npm start
```

The server binds to `127.0.0.1` and uses `data/cnc.db` (override with
`CNC_DB_PATH`). Stop it with `Ctrl+C` (SIGINT/SIGTERM close the HTTP server and
the database cleanly). Migrations run on every startup and are idempotent.

### API quick tour

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/machines -ContentType 'application/json' `
  -Body '{"code":"MC1","name":"Mill 1"}'
Invoke-RestMethod "http://127.0.0.1:<port>/life"
Invoke-RestMethod "http://127.0.0.1:<port>/work_orders?limit=20&offset=0"
```

Endpoints: `POST /machines /tools /programs /work-orders /features /gauges
/gauges/recalibrate /mounts /mounts/dismount /events /events/derive
/measurements /reevaluate /scrap-threshold /life/alerts`, `GET /life`,
`GET /health`, and paginated `GET /machines|tools|programs|work_orders|events|
measurements|mounts|segments|alerts|dispositions|traces|audit` with filters
`machine_code`, `work_order_code`, `feature_key`, `serial`, `gauge_code`,
`superseded` and paging `limit` (1..500) / `offset`.

Error responses use an explicit code: `VALIDATION_ERROR` (400), `NOT_FOUND`
(404), `CONFLICT` / `DUPLICATE_EVENT` / `EDGE_MOUNT_CONFLICT` (409),
`GAUGE_CALIBRATION_EXPIRED` (422).

## CLI

```powershell
npm run cli -- workorder add WO100 P-77 50
npm run cli -- feature add WO100 DIA 10 10.1 9.9
npm run cli -- machine add MC1 "Mill 1"
npm run cli -- tool add T-001 600000
npm run cli -- program add PRG-A 1.0
npm run cli -- gauge add G1 DIA 2592000000
npm run cli -- mount T-001 1 MC1 2026-03-01T00:00:00Z
npm run cli -- event ev-s1 MC1 cycle_start 2026-03-01T01:00:00Z PRG-A 1.0 WO100
npm run cli -- event ev-e1 MC1 cycle_end   2026-03-01T01:05:00Z PRG-A 1.0 WO100
npm run cli -- derive
npm run cli -- measure WO100 S1 DIA G1 2026-03-01T01:06:00Z 10.02
npm run cli -- life
npm run cli -- traces
npm run cli -- report WO100
```

Run `npm run cli` with no arguments for the full command list. The CLI prints
state before/after key operations (created ids, edge life, derived segment
counts and trace results).

## Repeatable end-to-end demo

```powershell
npm run demo
```

Generates a deterministic fictional scenario (seeded PRNG, injected clock) with
drift and a sudden edge break, derives edge-attributed cutting segments,
raises life/quality alerts, and applies a gauge-bias correction followed by
re-evaluation. The database is written to `data/demo.db` for inspection.
A pure CLI smoke walkthrough is available in `demo/cli-smoke.ps1`.

## Core rules implemented

- Raw `machine_events` and measurement rows are append-only; re-evaluation
  inserts new versions and marks old ones `superseded` (kept for audit).
- Cutting is attributed to the edge mount and program version active at cycle
  start; intervals crossing a tool change are clipped at the boundary.
- Overlapping cutting on the same edge is union-merged; duplicate event UIDs
  and out-of-order/clock-skewed events never double-count life.
- An edge can never be validly mounted on two machines at the same time
  (`BEGIN IMMEDIATE` transaction overlap check).
- Out-of-tolerance measurements trace all parts since the last passing
  measurement; rework-band failures and expired-gauge readings produce
  `reinspect`, gross deviations produce `confirmed_bad` scrap.
- Gauge calibration corrections and scrap-threshold changes re-evaluate
  current verdicts while preserving prior decisions and audit history.
