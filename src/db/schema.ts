export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      life_limit_ms INTEGER NOT NULL CHECK (life_limit_ms > 0),
      retired INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL REFERENCES tools(id),
      edge_no INTEGER NOT NULL,
      life_limit_ms INTEGER NOT NULL CHECK (life_limit_ms > 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE (tool_id, edge_no)
    );

    -- A tool edge may be mounted on at most one machine at any instant.
    -- Validity ranges are half-open: [mounted_at, dismounted_at).
    CREATE TABLE IF NOT EXISTS tool_mounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edge_id INTEGER NOT NULL REFERENCES tool_edges(id),
      machine_id INTEGER NOT NULL REFERENCES machines(id),
      mounted_at TEXT NOT NULL,
      dismounted_at TEXT,
      reason TEXT NOT NULL DEFAULT 'change'
    );

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (name, version)
    );

    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      part_no TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
      key TEXT NOT NULL,
      nominal REAL NOT NULL,
      usl REAL NOT NULL,
      lsl REAL NOT NULL,
      UNIQUE (work_order_id, key)
    );

    CREATE TABLE IF NOT EXISTS gauges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      feature_key TEXT NOT NULL,
      calibration_interval_ms INTEGER NOT NULL CHECK (calibration_interval_ms > 0),
      calibrated_at TEXT NOT NULL
    );

    -- Append-only calibration corrections. superseded rows stay for audit.
    CREATE TABLE IF NOT EXISTS gauge_calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gauge_id INTEGER NOT NULL REFERENCES gauges(id),
      calibrated_at TEXT NOT NULL,
      bias REAL NOT NULL DEFAULT 0,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Raw machine events: never updated, never deleted.
    CREATE TABLE IF NOT EXISTS machine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uid TEXT NOT NULL UNIQUE,
      machine_code TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('cycle_start','cycle_end','mount','dismount')),
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      clock_offset_ms INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      ingested_at TEXT NOT NULL
    );

    -- Derived cutting intervals: half-open [start, end), attributed to one
    -- edge mount and one program version. Deduplicated against raw events.
    CREATE TABLE IF NOT EXISTS cut_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_code TEXT NOT NULL,
      edge_id INTEGER NOT NULL REFERENCES tool_edges(id),
      mount_id INTEGER NOT NULL REFERENCES tool_mounts(id),
      program_id INTEGER NOT NULL REFERENCES programs(id),
      work_order_code TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      start_event_uid TEXT NOT NULL,
      end_event_uid TEXT NOT NULL,
      UNIQUE (start_event_uid, end_event_uid),
      CHECK (end_at > start_at OR duration_ms = 0)
    );

    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_code TEXT NOT NULL,
      serial TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      gauge_code TEXT NOT NULL,
      measured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      raw_value REAL NOT NULL,
      corrected_value REAL NOT NULL,
      calibration_id INTEGER NOT NULL REFERENCES gauge_calibrations(id),
      verdict TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      reeval_reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_meas_active ON measurements(
      work_order_code, serial, feature_key, measured_at, gauge_code, raw_value
    ) WHERE superseded = 0;

    CREATE TABLE IF NOT EXISTS dispositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_code TEXT NOT NULL,
      serial TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('scrap','rework','reinspect','ok')),
      reason TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0
    );

    -- Quality trace snapshot: suspicious window after last passing measurement.
    CREATE TABLE IF NOT EXISTS trace_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_code TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      trigger_measurement_id INTEGER NOT NULL REFERENCES measurements(id),
      since_measurement_id INTEGER,
      from_serial TEXT NOT NULL,
      to_serial TEXT,
      confidence TEXT NOT NULL CHECK (confidence IN ('reinspect','confirmed_bad')),
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      before_json TEXT,
      after_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mounts_edge ON tool_mounts(edge_id, mounted_at);
    CREATE INDEX IF NOT EXISTS idx_segments_edge ON cut_segments(edge_id);
    CREATE INDEX IF NOT EXISTS idx_meas_wo ON measurements(work_order_code, feature_key, measured_at);
    `
  }
];
