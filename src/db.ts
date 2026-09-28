import Database from "better-sqlite3";

/**
 * Migrations are idempotent: every statement uses IF NOT EXISTS and the
 * schema_version table records which migrations ran, so `migrate()` is safe
 * to call on every startup (including after a process restart).
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id INTEGER NOT NULL REFERENCES tools(id),
  edge_no INTEGER NOT NULL,
  life_limit_sec REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | retired
  UNIQUE (tool_id, edge_no)
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS workorders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  part_no TEXT NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  qty_target INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  created_at INTEGER NOT NULL
);

-- Tool edge installations. An edge has at most one active (removed_at IS NULL)
-- installation across ALL machines; enforced by the partial unique index below.
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_id INTEGER NOT NULL REFERENCES tool_edges(id),
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  installed_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_install_per_edge
  ON installations(edge_id) WHERE removed_at IS NULL;

-- Raw machine events: append-only, never updated or deleted.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,      -- idempotency key supplied by the source
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  type TEXT NOT NULL,                 -- cutting_start | cutting_stop | tool_install | tool_remove
  ts INTEGER NOT NULL,                -- machine-reported timestamp (may be skewed)
  seq INTEGER NOT NULL DEFAULT 0,     -- machine sequence number for tie-breaking
  payload TEXT NOT NULL DEFAULT '{}',
  received_at INTEGER NOT NULL        -- server clock at ingest
);
CREATE INDEX IF NOT EXISTS idx_events_machine_ts ON events(machine_id, ts, seq);

-- Derived cutting segments attributed to an edge + program version.
-- source_event_id is unique so re-importing the same start event can never
-- double-count life.
CREATE TABLE IF NOT EXISTS cutting_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  edge_id INTEGER NOT NULL REFERENCES tool_edges(id),
  program_id INTEGER REFERENCES programs(id),
  workorder_id INTEGER REFERENCES workorders(id),
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  seconds REAL NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_segments_edge ON cutting_segments(edge_id);

CREATE TABLE IF NOT EXISTS gauges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  cal_interval_days INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Calibration history is append-only; a "correction" inserts a new row.
CREATE TABLE IF NOT EXISTS gauge_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gauge_id INTEGER NOT NULL REFERENCES gauges(id),
  calibrated_at INTEGER NOT NULL,
  interval_days INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  recorded_at INTEGER NOT NULL
);

-- Raw measurement records: append-only, never overwritten.
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measurement_id TEXT NOT NULL UNIQUE, -- idempotency key
  workorder_id INTEGER NOT NULL REFERENCES workorders(id),
  workpiece_sn TEXT NOT NULL,
  feature TEXT NOT NULL,
  value REAL NOT NULL,
  nominal REAL NOT NULL,
  tol_plus REAL NOT NULL,
  tol_minus REAL NOT NULL,
  gauge_id INTEGER NOT NULL REFERENCES gauges(id),
  measured_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_measurements_wo ON measurements(workorder_id, feature, measured_at);

-- Judgements are versioned: re-evaluation inserts a new row and marks the old
-- one superseded; old verdicts are preserved for audit.
CREATE TABLE IF NOT EXISTS judgements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measurement_id INTEGER NOT NULL REFERENCES measurements(id),
  result TEXT NOT NULL,               -- pass | fail
  reason TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,                 -- e.g. 'tolerance-v1', 'tolerance-v2'
  judged_at INTEGER NOT NULL,
  superseded_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_judgement
  ON judgements(measurement_id) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS quality_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL UNIQUE,     -- idempotency key
  workorder_id INTEGER NOT NULL REFERENCES workorders(id),
  workpiece_sn TEXT NOT NULL,
  type TEXT NOT NULL,                 -- scrap | rework
  reason TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- drift | gauge_expired | life_exceeded
  message TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' -- open | acknowledged
);

CREATE TABLE IF NOT EXISTS suspect_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workorder_id INTEGER NOT NULL REFERENCES workorders(id),
  feature TEXT NOT NULL,
  trigger_measurement_id INTEGER NOT NULL REFERENCES measurements(id),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' -- open | closed
);

CREATE TABLE IF NOT EXISTS suspect_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES suspect_batches(id),
  workpiece_sn TEXT NOT NULL,
  classification TEXT NOT NULL,       -- recheck | reject
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE (batch_id, workpiece_sn)
);
`,
  },
  {
    version: 2,
    sql: `
-- Tunable quality rules (e.g. scrap threshold). Values are versioned by
-- updated_at so a threshold change can trigger re-evaluation while old
-- judgements remain stored.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
];

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version")
    .get() as { v: number };
  for (const m of MIGRATIONS) {
    if (m.version > row.v) {
      const run = db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
          m.version,
          Date.now()
        );
      });
      run();
    }
  }
}
