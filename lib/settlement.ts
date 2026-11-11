import type { DB } from "./db";
import type { PayPalGateway } from "./paypal";
import { appendEvent } from "./recorder";
import { bondBatchId, type Decision, type Fault, type Mandate, type Status } from "./store";
import { formatUsd } from "./util";
import { shortError } from "./mandate";

/**
 * Executes the money path for a verdict.
 *   AGENT    -> buyer refunded (by the merchant); agent operator's bond repays the merchant (payout)
 *   MERCHANT -> buyer refunded at the merchant's cost
 *   USER     -> no automatic refund; normal return policy
 *   null     -> manual review, no money moves
 */

export interface SettlementResult {
  status: Status;
  refundId: string | null;
  payoutId: string | null;
  note: string | null;
}

export function statusForFault(fault: Fault | null): Status {
  switch (fault) {
    case "AGENT":
      return "SETTLED_AGENT";
    case "MERCHANT":
      return "SETTLED_MERCHANT";
    case "USER":
      return "SETTLED_USER";
    default:
      return "MANUAL_REVIEW";
  }
}

export function merchantPayoutEmail(mode: PayPalGateway["mode"]): string | null {
  return process.env.PAYPAL_MERCHANT_EMAIL || (mode === "mock" ? "merchant@sandbox.example" : null);
}

export async function settle(db: DB, paypal: PayPalGateway, mandate: Mandate, decision: Decision, fault: Fault | null): Promise<SettlementResult> {
  const status = statusForFault(fault);
  if (status === "SETTLED_USER") {
    appendEvent(db, mandate.id, "settlement", { fault, action: "none", note: "User responsibility: normal return policy applies." });
    return { status, refundId: null, payoutId: null, note: "No automatic refund. The merchant's normal return policy applies." };
  }
  if (status === "MANUAL_REVIEW") {
    appendEvent(db, mandate.id, "settlement", { fault, action: "none", note: "Sent to manual review with the evidence pack." });
    return { status, refundId: null, payoutId: null, note: "Low confidence: sent to manual review. No money moved." };
  }

  const captureId = decision.captureId;
  const amount = decision.capturedAmountCents;
  if (!captureId || !amount) throw new Error("Cannot settle: no capture on record");

  const refund = await paypal.refundCapture({
    captureId,
    amountCents: amount,
    note: `Sentinel verdict: ${fault === "AGENT" ? "agent" : "merchant"} fault. Full refund.`,
    requestId: `refund-${mandate.id}`,
  });
  appendEvent(db, mandate.id, "settlement", { action: "refund", refundId: refund.refundId, amount: formatUsd(amount), status: refund.status });

  if (fault === "MERCHANT") {
    return { status, refundId: refund.refundId, payoutId: null, note: `Buyer refunded ${formatUsd(amount)} at the merchant's cost.` };
  }

  // AGENT fault: the operator's bond makes the merchant whole.
  const receiver = merchantPayoutEmail(paypal.mode);
  if (!receiver) {
    const note = `Buyer refunded ${formatUsd(amount)}. Bond payout NOT sent: PAYPAL_MERCHANT_EMAIL is not configured.`;
    appendEvent(db, mandate.id, "settlement", { action: "payout_skipped", reason: "PAYPAL_MERCHANT_EMAIL missing" });
    return { status, refundId: refund.refundId, payoutId: null, note };
  }
  try {
    const payout = await paypal.operatorPayout({
      receiverEmail: receiver,
      amountCents: amount,
      note: `Agent operator bond: reimbursement for mandate ${mandate.id} (agent fault).`,
      senderBatchId: bondBatchId(mandate.id),
    });
    appendEvent(db, mandate.id, "settlement", {
      action: "bond_payout",
      payoutBatchId: payout.payoutBatchId,
      amount: formatUsd(amount),
      receiver,
      status: payout.status,
    });
    return {
      status,
      refundId: refund.refundId,
      payoutId: payout.payoutBatchId,
      note: `Buyer refunded ${formatUsd(amount)}; agent operator's bond paid ${formatUsd(amount)} to the merchant.`,
    };
  } catch (err) {
    // The refund already happened; record the failed bond payout honestly.
    appendEvent(db, mandate.id, "paypal_error", { action: "bond_payout", error: shortError(err) });
    return {
      status,
      refundId: refund.refundId,
      payoutId: null,
      note: `Buyer refunded ${formatUsd(amount)}. Bond payout failed (${shortError(err)}); operator must be invoiced.`,
    };
  }
}
