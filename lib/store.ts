import type { DB } from "./db";
import type { MandateRules } from "./mandate";
import type { RuleResult, RuleId } from "./policy";
import { appendEvent } from "./recorder";
import type { WebhookEvent } from "./paypal";
import { HttpError, newId, nowIso } from "./util";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const STATUSES = [
  "DRAFT",
  "AUTHORIZED",
  "PROPOSED",
  "VOIDED",
  "CAPTURED",
  "DISPUTED",
  "SETTLED_AGENT",
  "SETTLED_MERCHANT",
  "SETTLED_USER",
  "MANUAL_REVIEW",
] as const;
export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Partial<Record<Status, Status[]>> = {
  DRAFT: ["AUTHORIZED"],
  AUTHORIZED: ["PROPOSED", "VOIDED"], // VOIDED directly when the agent proposes nothing
  PROPOSED: ["CAPTURED", "VOIDED"],
  CAPTURED: ["DISPUTED"],
  DISPUTED: ["SETTLED_AGENT", "SETTLED_MERCHANT", "SETTLED_USER", "MANUAL_REVIEW"],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Compare-and-set status change. Throws 409 if the mandate is not in `from`. */
export function transition(db: DB, id: string, from: Status, to: Status, extra: Record<string, unknown> = {}) {
  if (!canTransition(from, to)) throw new HttpError(409, `Illegal transition ${from} -> ${to}`);
  const cols = Object.keys(extra);
  const set = ["status = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  const info = db
    .prepare(`UPDATE mandates SET ${set} WHERE id = ? AND status = ?`)
    .run(to, nowIso(), ...cols.map((c) => extra[c] as never), id, from);
  if (info.changes !== 1) {
    const cur = getMandateRow(db, id);
    throw new HttpError(409, `Mandate is ${cur?.status ?? "missing"}, expected ${from}`);
  }
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

export interface Mandate {
  id: string;
  createdAt: string;
  updatedAt: string;
  rawIntent: string;
  rules: MandateRules;
  ceilingCents: number;
  currency: string;
  status: Status;
  scenario: string | null;
  extractor: string;
  paypalOrderId: string | null;
  authorizationId: string | null;
  authorizedAmountCents: number | null;
  authorizationExpiresAt: string | null;
  runStartedAt: string | null;
}

type Row = Record<string, unknown>;

function getMandateRow(db: DB, id: string): Row | undefined {
  return db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as Row | undefined;
}

function toMandate(r: Row): Mandate {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    rawIntent: r.raw_intent as string,
    rules: JSON.parse(r.rules_json as string),
    ceilingCents: r.ceiling as number,
    currency: r.currency as string,
    status: r.status as Status,
    scenario: (r.scenario as string) ?? null,
    extractor: r.extractor as string,
    paypalOrderId: (r.paypal_order_id as string) ?? null,
    authorizationId: (r.authorization_id as string) ?? null,
    authorizedAmountCents: (r.authorized_amount as number) ?? null,
    authorizationExpiresAt: (r.authorization_expires_at as string) ?? null,
    runStartedAt: (r.run_started_at as string) ?? null,
  };
}

export function getMandate(db: DB, id: string): Mandate | null {
  const r = getMandateRow(db, id);
  return r ? toMandate(r) : null;
}

export function requireMandate(db: DB, id: string): Mandate {
  const m = getMandate(db, id);
  if (!m) throw new HttpError(404, `Mandate ${id} not found`);
  return m;
}

export function createMandate(
  db: DB,
  args: { rawIntent: string; rules: MandateRules; scenario: string | null; extractor: string; warnings: string[] },
): Mandate {
  const id = newId("mdt");
  const now = nowIso();
  db.prepare(
    `INSERT INTO mandates (id, created_at, updated_at, raw_intent, rules_json, ceiling, currency, status, scenario, extractor)
     VALUES (?, ?, ?, ?, ?, ?, 'USD', 'DRAFT', ?, ?)`,
  ).run(id, now, now, args.rawIntent, JSON.stringify(args.rules), args.rules.ceilingCents, args.scenario, args.extractor);
  appendEvent(db, id, "mandate_created", {
    rawIntent: args.rawIntent,
    rules: args.rules,
    extractor: args.extractor,
    warnings: args.warnings,
  });
  return getMandate(db, id)!;
}

/** The user may edit the extracted mandate, but only before approving the budget. */
export function updateMandateRules(db: DB, id: string, rules: MandateRules): Mandate {
  const info = db
    .prepare("UPDATE mandates SET rules_json = ?, ceiling = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT' AND paypal_order_id IS NULL")
    .run(JSON.stringify(rules), rules.ceilingCents, nowIso(), id);
  if (info.changes !== 1) throw new HttpError(409, "Mandate can only be edited before the budget order is created");
  appendEvent(db, id, "mandate_edited", { rules });
  return getMandate(db, id)!;
}

export function setOrderId(db: DB, id: string, orderId: string) {
  db.prepare("UPDATE mandates SET paypal_order_id = ?, updated_at = ? WHERE id = ?").run(orderId, nowIso(), id);
}

/** Claims the single agent run for this mandate. Returns false if already claimed. */
export function claimRun(db: DB, id: string): boolean {
  const info = db
    .prepare("UPDATE mandates SET run_started_at = ?, updated_at = ? WHERE id = ? AND status = 'AUTHORIZED' AND run_started_at IS NULL")
    .run(nowIso(), nowIso(), id);
  return info.changes === 1;
}

export function listMandates(db: DB): Mandate[] {
  return (db.prepare("SELECT * FROM mandates ORDER BY created_at DESC").all() as Row[]).map(toMandate);
}

// ---------------------------------------------------------------------------
// Decisions and verdicts
// ---------------------------------------------------------------------------

export interface Decision {
  mandateId: string;
  outcome: "CAPTURED" | "VOIDED";
  failedRules: (RuleId | string)[];
  results: RuleResult[];
  listingId: string | null;
  addOnIds: string[];
  totalCents: number | null;
  captureId: string | null;
  capturedAmountCents: number | null;
  createdAt: string;
}

export function saveDecision(db: DB, d: Omit<Decision, "createdAt">) {
  db.prepare(
    `INSERT INTO decisions (mandate_id, outcome, failed_rules_json, results_json, listing_id, add_ons_json, total, capture_id, captured_amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.mandateId,
    d.outcome,
    JSON.stringify(d.failedRules),
    JSON.stringify(d.results),
    d.listingId,
    JSON.stringify(d.addOnIds),
    d.totalCents,
    d.captureId,
    d.capturedAmountCents,
    nowIso(),
  );
}

export function getDecision(db: DB, mandateId: string): Decision | null {
  const r = db.prepare("SELECT * FROM decisions WHERE mandate_id = ?").get(mandateId) as Row | undefined;
  if (!r) return null;
  return {
    mandateId,
    outcome: r.outcome as Decision["outcome"],
    failedRules: JSON.parse(r.failed_rules_json as string),
    results: JSON.parse(r.results_json as string),
    listingId: (r.listing_id as string) ?? null,
    addOnIds: JSON.parse(r.add_ons_json as string),
    totalCents: (r.total as number) ?? null,
    captureId: (r.capture_id as string) ?? null,
    capturedAmountCents: (r.captured_amount as number) ?? null,
    createdAt: r.created_at as string,
  };
}

export type Fault = "AGENT" | "MERCHANT" | "USER";

export interface Evidence {
  source: "mandate" | "snapshot" | "current_listing" | "complaint" | "trace";
  text: string;
}

export interface Verdict {
  mandateId: string;
  complaint: string;
  fault: Fault | null;
  outcomeStatus: Status;
  confidence: number;
  method: "mechanical" | "llm" | "none";
  reasoning: string;
  evidence: Evidence[];
  refundId: string | null;
  payoutId: string | null;
  settlementNote: string | null;
  createdAt: string;
}

export function saveVerdict(db: DB, v: Omit<Verdict, "createdAt">) {
  db.prepare(
    `INSERT INTO verdicts (mandate_id, complaint, fault, outcome_status, confidence, method, reasoning, evidence_json, refund_id, payout_id, settlement_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v.mandateId,
    v.complaint,
    v.fault,
    v.outcomeStatus,
    v.confidence,
    v.method,
    v.reasoning,
    JSON.stringify(v.evidence),
    v.refundId,
    v.payoutId,
    v.settlementNote,
    nowIso(),
  );
}

export function getVerdict(db: DB, mandateId: string): Verdict | null {
  const r = db.prepare("SELECT * FROM verdicts WHERE mandate_id = ?").get(mandateId) as Row | undefined;
  if (!r) return null;
  return {
    mandateId,
    complaint: r.complaint as string,
    fault: (r.fault as Fault) ?? null,
    outcomeStatus: r.outcome_status as Status,
    confidence: r.confidence as number,
    method: r.method as Verdict["method"],
    reasoning: r.reasoning as string,
    evidence: JSON.parse(r.evidence_json as string),
    refundId: (r.refund_id as string) ?? null,
    payoutId: (r.payout_id as string) ?? null,
    settlementNote: (r.settlement_note as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string;
  eventType: string;
  resourceId: string | null;
  mandateId: string | null;
  verified: boolean;
  simulated: boolean;
  receivedAt: string;
}

/** PayPal resource id; payouts batches keep theirs in batch_header. */
export function webhookResourceId(event: WebhookEvent): string | null {
  const r = event.resource as { id?: string; batch_header?: { payout_batch_id?: string } } | undefined;
  return r?.id ?? r?.batch_header?.payout_batch_id ?? null;
}

/** Bond payouts use sender_batch_id = "bond-<mandateId>". */
export function bondBatchId(mandateId: string): string {
  return `bond-${mandateId}`;
}

/** Finds the mandate a PayPal resource belongs to (custom_id carries the mandate id). */
function mandateForResource(db: DB, event: WebhookEvent): string | null {
  const custom = event.resource?.custom_id;
  if (custom && getMandateRow(db, custom)) return custom;
  const batch = (event.resource as { batch_header?: { sender_batch_header?: { sender_batch_id?: string } } } | undefined)?.batch_header
    ?.sender_batch_header?.sender_batch_id;
  if (batch?.startsWith("bond-") && getMandateRow(db, batch.slice(5))) return batch.slice(5);
  const rid = webhookResourceId(event);
  if (!rid) return null;
  const m =
    (db.prepare("SELECT id FROM mandates WHERE authorization_id = ? OR paypal_order_id = ?").get(rid, rid) as Row | undefined) ??
    (db.prepare("SELECT mandate_id AS id FROM decisions WHERE capture_id = ?").get(rid) as Row | undefined) ??
    (db.prepare("SELECT mandate_id AS id FROM verdicts WHERE refund_id = ? OR payout_id = ?").get(rid, rid) as Row | undefined);
  return (m?.id as string) ?? null;
}

/**
 * Records a webhook (idempotent on event id). Only verified events are
 * written into the mandate's flight recorder as confirmations.
 */
export function ingestWebhook(db: DB, event: WebhookEvent, verified: boolean, simulated: boolean): { duplicate: boolean; mandateId: string | null } {
  const mandateId = mandateForResource(db, event);
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, mandate_id, verified, simulated, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(event.id, event.event_type, webhookResourceId(event), mandateId, verified ? 1 : 0, simulated ? 1 : 0, nowIso());
  const duplicate = info.changes === 0;
  if (!duplicate && verified && mandateId) {
    appendEvent(db, mandateId, "webhook_confirmed", {
      eventId: event.id,
      eventType: event.event_type,
      resourceId: webhookResourceId(event),
      simulated,
    });
  }
  return { duplicate, mandateId };
}

export function getWebhooks(db: DB, mandateId?: string): WebhookRow[] {
  const rows = (
    mandateId
      ? db.prepare("SELECT * FROM webhook_events WHERE mandate_id = ? ORDER BY received_at").all(mandateId)
      : db.prepare("SELECT * FROM webhook_events ORDER BY received_at DESC").all()
  ) as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    eventType: r.event_type as string,
    resourceId: (r.resource_id as string) ?? null,
    mandateId: (r.mandate_id as string) ?? null,
    verified: r.verified === 1,
    simulated: r.simulated === 1,
    receivedAt: r.received_at as string,
  }));
}
