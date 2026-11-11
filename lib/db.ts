import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_intent TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  ceiling INTEGER NOT NULL,              -- cents
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  scenario TEXT,                          -- demo scenario key, if any
  extractor TEXT NOT NULL,                -- 'llm' | 'heuristic'
  paypal_order_id TEXT,
  authorization_id TEXT,
  authorized_amount INTEGER,              -- cents
  authorization_expires_at TEXT,
  run_started_at TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mandate_id, seq)
);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  listing_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL UNIQUE REFERENCES mandates(id),
  outcome TEXT NOT NULL,                  -- CAPTURED | VOIDED
  failed_rules_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  listing_id TEXT,
  add_ons_json TEXT NOT NULL DEFAULT '[]',
  total INTEGER,                          -- cents, server-computed
  capture_id TEXT,
  captured_amount INTEGER,                -- cents
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL UNIQUE REFERENCES mandates(id),
  complaint TEXT NOT NULL,
  fault TEXT,                             -- AGENT | MERCHANT | USER | NULL (undetermined)
  outcome_status TEXT NOT NULL,           -- final mandate status
  confidence REAL NOT NULL,
  method TEXT NOT NULL,                   -- mechanical | llm | none
  reasoning TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  refund_id TEXT,
  payout_id TEXT,
  settlement_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,                    -- PayPal event id (dedupe)
  event_type TEXT NOT NULL,
  resource_id TEXT,
  mandate_id TEXT,
  verified INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);

-- Demo-only: lets the fictional merchant edit a listing after purchase.
CREATE TABLE IF NOT EXISTS listing_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trace_mandate ON trace_events(mandate_id, seq);
CREATE INDEX IF NOT EXISTS idx_snap_mandate ON listing_snapshots(mandate_id, listing_id);
`;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const globalForDb = globalThis as unknown as { __sentinelDb?: DB };

/**
 * One SQLite connection per process. The file is wiped on the first open of a
 * new process ("reseeded on boot"): every visitor of the hosted demo gets a
 * clean state. Set SENTINEL_KEEP_DB=1 to keep data across restarts.
 */
export function getDb(): DB {
  if (globalForDb.__sentinelDb) return globalForDb.__sentinelDb;
  const file = process.env.SENTINEL_DB_PATH || path.join(process.cwd(), ".data", "sentinel.db");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (process.env.SENTINEL_KEEP_DB !== "1") {
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    }
  }
  globalForDb.__sentinelDb = openDb(file);
  return globalForDb.__sentinelDb;
}

/** Test helper: swap in a fresh database. */
export function resetDbForTests(): DB {
  globalForDb.__sentinelDb?.close();
  globalForDb.__sentinelDb = openDb(":memory:");
  return globalForDb.__sentinelDb;
}
