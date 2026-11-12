import type { DB } from "./db";
import type { PayPalGateway } from "./paypal";
import { PayPalError } from "./paypal";
import { applyMerchantEdit, getListing } from "./catalog";
import { runAgent, type AgentMode, type AgentRun } from "./agent";
import { scanListing } from "./injection";
import { evaluatePolicy, type PolicyDecision } from "./policy";
import { arbitrate, confidenceThreshold, type ArbiterResult } from "./arbiter";
import { settle } from "./settlement";
import { appendEvent, getTrace, latestSnapshot, verifyChain } from "./recorder";
import {
  claimRun,
  getDecision,
  requireMandate,
  saveDecision,
  saveVerdict,
  setOrderId,
  transition,
  type Mandate,
  type Verdict,
} from "./store";
import { shortError } from "./mandate";
import { formatUsd, HttpError } from "./util";

/**
 * Sentinel core: the only place where PayPal state changes are triggered.
 * The model never decides whether money moves before capture; the policy engine does.
 */

// ---------------------------------------------------------------------------
// Budget hold
// ---------------------------------------------------------------------------

export async function createBudgetOrder(db: DB, paypal: PayPalGateway, mandateId: string): Promise<{ orderId: string }> {
  const m = requireMandate(db, mandateId);
  if (m.status !== "DRAFT") throw new HttpError(409, `Mandate is ${m.status}; the budget can only be held once`);
  const { orderId } = await paypal.createAuthorizeOrder({
    mandateId: m.id,
    amountCents: m.rules.ceilingCents,
    description: `Sentinel budget hold: ${m.rules.summary}`,
  });
  if (m.paypalOrderId !== orderId) {
    setOrderId(db, m.id, orderId);
    appendEvent(db, m.id, "order_created", { orderId, intent: "AUTHORIZE", amount: formatUsd(m.rules.ceilingCents) });
  }
  return { orderId };
}

export async function authorizeBudget(db: DB, paypal: PayPalGateway, mandateId: string, orderId: string): Promise<Mandate> {
  const m = requireMandate(db, mandateId);
  if (m.status !== "DRAFT") throw new HttpError(409, `Mandate is ${m.status}`);
  if (!m.paypalOrderId || m.paypalOrderId !== orderId) throw new HttpError(400, "Order id does not belong to this mandate");
  const auth = await paypal.authorizeOrder(orderId);
  // Defence in depth: PayPal's view must match the mandate.
  if (auth.customId && auth.customId !== m.id) throw new HttpError(400, "Authorization custom_id does not match the mandate");
  if (auth.amountCents !== m.rules.ceilingCents)
    throw new HttpError(400, `Authorized ${formatUsd(auth.amountCents)} but the mandate ceiling is ${formatUsd(m.rules.ceilingCents)}`);
  if (auth.status !== "CREATED") throw new HttpError(402, `Authorization status is ${auth.status}`);
  transition(db, m.id, "DRAFT", "AUTHORIZED", {
    authorization_id: auth.authorizationId,
    authorized_amount: auth.amountCents,
    authorization_expires_at: auth.expiresAt,
  });
  appendEvent(db, m.id, "budget_authorized", {
    orderId,
    authorizationId: auth.authorizationId,
    amount: formatUsd(auth.amountCents),
    expiresAt: auth.expiresAt,
  });
  return requireMandate(db, m.id);
}

// ---------------------------------------------------------------------------
// Agent run + firewall
// ---------------------------------------------------------------------------

export interface RunResult {
  agent: AgentRun;
  policy: PolicyDecision | null;
  outcome: "CAPTURED" | "VOIDED";
  captureId: string | null;
}

export async function runMandate(db: DB, paypal: PayPalGateway, mandateId: string, mode: AgentMode): Promise<RunResult> {
  const m = requireMandate(db, mandateId);
  if (m.status !== "AUTHORIZED" || !m.authorizationId) throw new HttpError(409, `Mandate is ${m.status}; it must be AUTHORIZED to run`);
  if (!claimRun(db, m.id)) throw new HttpError(409, "This mandate has already been run");

  // The run is claimed: whatever happens below, the hold must end up captured or voided, never stranded.
  let agent: AgentRun;
  try {
    agent = await runAgent(db, m, mode);
  } catch (err) {
    appendEvent(db, m.id, "agent_fallback", { reason: shortError(err), to: "none" });
    agent = { proposal: null, modeUsed: mode, fallbackReason: shortError(err) };
  }

  if (!agent.proposal) {
    await voidHold(db, paypal, m, "The agent did not propose a purchase");
    transition(db, m.id, "AUTHORIZED", "VOIDED");
    saveDecision(db, {
      mandateId: m.id,
      outcome: "VOIDED",
      failedRules: ["NO_PROPOSAL"],
      results: [],
      listingId: null,
      addOnIds: [],
      totalCents: null,
      captureId: null,
      capturedAmountCents: null,
    });
    return { agent, policy: null, outcome: "VOIDED", captureId: null };
  }

  transition(db, m.id, "AUTHORIZED", "PROPOSED");
  const proposal = agent.proposal;

  // Everything below is read server-side; nothing the agent says is trusted.
  const listing = getListing(db, proposal.listingId);
  const snapshot = latestSnapshot(db, m.id, proposal.listingId);
  const injection = listing ? await scanListing(listing) : { flagged: false, patternHits: [], llm: { ran: false } };
  appendEvent(db, m.id, "injection_scan", { listingId: proposal.listingId, ...injection });

  let authState;
  try {
    authState = await paypal.getAuthorization(m.authorizationId);
  } catch (err) {
    appendEvent(db, m.id, "paypal_error", { action: "get_authorization", error: shortError(err) });
    authState = { status: "UNKNOWN", amountCents: 0, expiresAt: null };
  }

  const policy = evaluatePolicy({
    rules: m.rules,
    proposal,
    listing,
    snapshot,
    injectionFlagged: injection.flagged,
    authorization: authState,
  });
  appendEvent(db, m.id, "policy_decision", {
    pass: policy.pass,
    failedRules: policy.failedRules,
    results: policy.results,
    total: policy.breakdown ? formatUsd(policy.breakdown.totalCents) : null,
    lines: policy.breakdown?.lines.map((l) => ({ label: l.label, amount: formatUsd(l.cents) })),
  });

  const base = {
    mandateId: m.id,
    results: policy.results,
    listingId: proposal.listingId,
    addOnIds: proposal.addOnIds,
    totalCents: policy.breakdown?.totalCents ?? null,
  };

  if (policy.pass && policy.captureAmountCents) {
    try {
      const cap = await paypal.captureAuthorization({
        authorizationId: m.authorizationId,
        amountCents: policy.captureAmountCents,
        invoiceId: m.id,
        requestId: `capture-${m.id}`,
      });
      appendEvent(db, m.id, "paypal_capture", {
        captureId: cap.captureId,
        status: cap.status,
        captured: formatUsd(cap.amountCents),
        released: formatUsd((m.authorizedAmountCents ?? 0) - cap.amountCents),
        finalCapture: true,
      });
      transition(db, m.id, "PROPOSED", "CAPTURED");
      saveDecision(db, { ...base, outcome: "CAPTURED", failedRules: [], captureId: cap.captureId, capturedAmountCents: cap.amountCents });
      return { agent, policy, outcome: "CAPTURED", captureId: cap.captureId };
    } catch (err) {
      // Rules passed but PayPal refused the capture: release the hold.
      appendEvent(db, m.id, "paypal_error", { action: "capture", error: shortError(err) });
      await voidHold(db, paypal, m, "Capture failed");
      transition(db, m.id, "PROPOSED", "VOIDED");
      saveDecision(db, { ...base, outcome: "VOIDED", failedRules: ["PAYPAL_CAPTURE_ERROR"], captureId: null, capturedAmountCents: null });
      return { agent, policy, outcome: "VOIDED", captureId: null };
    }
  }

  await voidHold(db, paypal, m, `Hard rule(s) failed: ${policy.failedRules.join(", ")}`);
  transition(db, m.id, "PROPOSED", "VOIDED");
  saveDecision(db, { ...base, outcome: "VOIDED", failedRules: policy.failedRules, captureId: null, capturedAmountCents: null });
  return { agent, policy, outcome: "VOIDED", captureId: null };
}

async function voidHold(db: DB, paypal: PayPalGateway, m: Mandate, reason: string) {
  try {
    const v = await paypal.voidAuthorization({ authorizationId: m.authorizationId!, requestId: `void-${m.id}` });
    appendEvent(db, m.id, "paypal_void", { authorizationId: m.authorizationId, status: v.status, reason, released: formatUsd(m.authorizedAmountCents ?? 0) });
  } catch (err) {
    // An already-voided/expired authorization moves no money either; record and continue.
    appendEvent(db, m.id, "paypal_error", {
      action: "void",
      error: shortError(err),
      paypalStatus: err instanceof PayPalError ? err.httpStatus : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Recourse
// ---------------------------------------------------------------------------

export async function fileComplaint(
  db: DB,
  paypal: PayPalGateway,
  mandateId: string,
  complaint: string,
): Promise<{ verdict: Verdict; arbiter: ArbiterResult }> {
  const m = requireMandate(db, mandateId);
  if (m.status !== "CAPTURED") throw new HttpError(409, `Only captured purchases can be disputed (mandate is ${m.status})`);
  const decision = getDecision(db, m.id);
  if (!decision?.listingId || !decision.captureId) throw new HttpError(409, "No captured purchase on record");

  transition(db, m.id, "CAPTURED", "DISPUTED");
  appendEvent(db, m.id, "complaint", { text: complaint });

  const chain = verifyChain(getTrace(db, m.id));
  const arbiter = await arbitrate({
    rawIntent: m.rawIntent,
    rules: m.rules,
    complaint,
    chain,
    snapshot: latestSnapshot(db, m.id, decision.listingId),
    currentListing: getListing(db, decision.listingId),
  });

  const threshold = confidenceThreshold();
  const fault = arbiter.fault && arbiter.confidence >= threshold ? arbiter.fault : null;
  appendEvent(db, m.id, "verdict", {
    fault: arbiter.fault,
    confidence: arbiter.confidence,
    threshold,
    method: arbiter.method,
    reasoning: arbiter.reasoning,
    evidence: arbiter.evidence,
    actedOn: fault,
  });

  let settlement;
  try {
    settlement = await settle(db, paypal, m, decision, fault);
  } catch (err) {
    appendEvent(db, m.id, "paypal_error", { action: "settlement", error: shortError(err) });
    settlement = { status: "MANUAL_REVIEW" as const, refundId: null, payoutId: null, note: `Settlement failed (${shortError(err)}); sent to manual review.` };
  }

  transition(db, m.id, "DISPUTED", settlement.status);
  const verdict: Omit<Verdict, "createdAt"> = {
    mandateId: m.id,
    complaint,
    fault: settlement.status === "MANUAL_REVIEW" ? null : fault,
    outcomeStatus: settlement.status,
    confidence: arbiter.confidence,
    method: arbiter.method,
    reasoning: arbiter.reasoning,
    evidence: arbiter.evidence,
    refundId: settlement.refundId,
    payoutId: settlement.payoutId,
    settlementNote: settlement.note,
  };
  saveVerdict(db, verdict);
  return { verdict: { ...verdict, createdAt: new Date().toISOString() }, arbiter };
}

/** Demo-only: the fictional merchant quietly edits the listing after a purchase. */
export function simulateMerchantEdit(db: DB, mandateId: string) {
  const m = requireMandate(db, mandateId);
  const decision = getDecision(db, m.id);
  if (m.status !== "CAPTURED" || !decision?.listingId) throw new HttpError(409, "Only a captured purchase can be used for this demo");
  const before = getListing(db, decision.listingId)!;
  const after = applyMerchantEdit(db, decision.listingId, {
    description: `${before.description} Update: ships with a USB-A cable only; USB-C adapter sold separately.`,
    features: before.features.filter((f) => f !== "USB-C").concat("USB-A"),
  });
  appendEvent(db, m.id, "merchant_edit", { listingId: after.id, simulated: true, note: "Merchant edited the listing after purchase" });
  return after;
}
