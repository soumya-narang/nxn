import type { DB } from "./db";
import type { Listing } from "./catalog";
import { canonicalJson, nowIso, sha256 } from "./util";

/**
 * Flight recorder: an append-only, hash-chained log of every agent step and
 * every Sentinel decision for a mandate, plus a snapshot of each listing the
 * agent looked at. Each entry's hash covers the previous entry's hash, so
 * editing or deleting any entry breaks the chain from that point on.
 */

export const GENESIS_HASH = "0".repeat(64);

export type TraceType =
  | "mandate_created"
  | "mandate_edited"
  | "order_created"
  | "budget_authorized"
  | "agent_started"
  | "agent_message"
  | "agent_fallback"
  | "tool_call"
  | "tool_result"
  | "listing_snapshot"
  | "injection_scan"
  | "proposal"
  | "policy_decision"
  | "paypal_capture"
  | "paypal_void"
  | "paypal_error"
  | "merchant_edit"
  | "complaint"
  | "verdict"
  | "settlement"
  | "webhook_confirmed";

export interface TraceEvent {
  id: number;
  mandateId: string;
  seq: number;
  type: TraceType;
  payload: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface Snapshot {
  id: number;
  mandateId: string;
  listingId: string;
  content: Listing;
  hash: string;
  createdAt: string;
}

function entryHash(e: { mandateId: string; seq: number; type: string; payload: unknown; prevHash: string; createdAt: string }) {
  return sha256(
    canonicalJson({ mandateId: e.mandateId, seq: e.seq, type: e.type, payload: e.payload, prevHash: e.prevHash, createdAt: e.createdAt }),
  );
}

export function appendEvent(db: DB, mandateId: string, type: TraceType, payload: unknown): TraceEvent {
  const insert = db.transaction(() => {
    const last = db
      .prepare("SELECT seq, hash FROM trace_events WHERE mandate_id = ? ORDER BY seq DESC LIMIT 1")
      .get(mandateId) as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const createdAt = nowIso();
    // Round-trip through JSON so the hashed payload equals what is stored.
    const normalised = JSON.parse(canonicalJson(payload ?? null));
    const hash = entryHash({ mandateId, seq, type, payload: normalised, prevHash, createdAt });
    const info = db
      .prepare(
        "INSERT INTO trace_events (mandate_id, seq, type, payload_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(mandateId, seq, type, canonicalJson(normalised), prevHash, hash, createdAt);
    return { id: Number(info.lastInsertRowid), mandateId, seq, type, payload: normalised, prevHash, hash, createdAt };
  });
  return insert.immediate();
}

export function getTrace(db: DB, mandateId: string): TraceEvent[] {
  const rows = db
    .prepare("SELECT * FROM trace_events WHERE mandate_id = ? ORDER BY seq")
    .all(mandateId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    mandateId: r.mandate_id as string,
    seq: r.seq as number,
    type: r.type as TraceType,
    payload: JSON.parse(r.payload_json as string),
    prevHash: r.prev_hash as string,
    hash: r.hash as string,
    createdAt: r.created_at as string,
  }));
}

export interface ChainCheck {
  ok: boolean;
  length: number;
  brokenAtSeq?: number;
  reason?: string;
  headHash: string;
}

export function verifyChain(events: TraceEvent[]): ChainCheck {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, length: events.length, brokenAtSeq: e.seq, reason: "sequence gap", headHash: prev };
    if (e.prevHash !== prev)
      return { ok: false, length: events.length, brokenAtSeq: e.seq, reason: "prev_hash mismatch", headHash: prev };
    if (entryHash(e) !== e.hash)
      return { ok: false, length: events.length, brokenAtSeq: e.seq, reason: "entry hash mismatch", headHash: prev };
    prev = e.hash;
  }
  return { ok: true, length: events.length, headHash: prev };
}

export function snapshotListing(db: DB, mandateId: string, listing: Listing): Snapshot {
  const contentJson = canonicalJson(listing);
  const hash = sha256(contentJson);
  const createdAt = nowIso();
  const info = db
    .prepare("INSERT INTO listing_snapshots (mandate_id, listing_id, content_json, hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(mandateId, listing.id, contentJson, hash, createdAt);
  appendEvent(db, mandateId, "listing_snapshot", { listingId: listing.id, hash });
  return { id: Number(info.lastInsertRowid), mandateId, listingId: listing.id, content: JSON.parse(contentJson), hash, createdAt };
}

function rowToSnapshot(r: Record<string, unknown>): Snapshot {
  return {
    id: r.id as number,
    mandateId: r.mandate_id as string,
    listingId: r.listing_id as string,
    content: JSON.parse(r.content_json as string),
    hash: r.hash as string,
    createdAt: r.created_at as string,
  };
}

export function getSnapshots(db: DB, mandateId: string): Snapshot[] {
  return (db.prepare("SELECT * FROM listing_snapshots WHERE mandate_id = ? ORDER BY id").all(mandateId) as Record<string, unknown>[]).map(
    rowToSnapshot,
  );
}

/** The most recent snapshot of a listing the agent viewed under this mandate. */
export function latestSnapshot(db: DB, mandateId: string, listingId: string): Snapshot | null {
  const r = db
    .prepare("SELECT * FROM listing_snapshots WHERE mandate_id = ? AND listing_id = ? ORDER BY id DESC LIMIT 1")
    .get(mandateId, listingId) as Record<string, unknown> | undefined;
  return r ? rowToSnapshot(r) : null;
}

/** A snapshot is only trustworthy if its content still hashes to the recorded value. */
export function snapshotIntact(s: Snapshot): boolean {
  return sha256(canonicalJson(s.content)) === s.hash;
}
