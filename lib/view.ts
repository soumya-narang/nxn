import type { DB } from "./db";
import { computeTotal, getListing, listingHash } from "./catalog";
import { getSnapshots, getTrace, verifyChain } from "./recorder";
import { getDecision, getVerdict, getWebhooks, listMandates, requireMandate } from "./store";
import { getScenario } from "./scenarios";
import { formatUsd } from "./util";

/** Everything the run page shows for one mandate. */
export function mandateView(db: DB, id: string) {
  const mandate = requireMandate(db, id);
  const trace = getTrace(db, id);
  const decision = getDecision(db, id);
  const snapshots = getSnapshots(db, id);
  const purchased = decision?.listingId ? getListing(db, decision.listingId) : null;
  const purchasedSnapshot = decision?.listingId ? [...snapshots].reverse().find((s) => s.listingId === decision.listingId) : undefined;
  // The total the firewall evaluated, split into its parts (from the listing as the agent saw it).
  const evaluated = purchasedSnapshot?.content ?? purchased;
  const breakdown = decision && evaluated ? computeTotal(evaluated, decision.addOnIds) : null;
  return {
    breakdown: breakdown
      ? {
          itemCents: breakdown.itemCents,
          shippingCents: breakdown.shippingCents,
          taxCents: breakdown.taxCents,
          addOns: decision!.addOnIds
            .map((id) => evaluated!.addOns.find((a) => a.id === id))
            .filter((a): a is NonNullable<typeof a> => Boolean(a))
            .map((a) => ({ id: a.id, name: a.name, cents: a.priceCents, recurring: a.recurring })),
          totalCents: breakdown.totalCents,
          title: evaluated!.title,
        }
      : null,
    mandate,
    scenario: getScenario(mandate.scenario) ?? null,
    trace,
    chain: verifyChain(trace),
    snapshots: snapshots.map((s) => ({ id: s.id, listingId: s.listingId, title: s.content.title, hash: s.hash, createdAt: s.createdAt })),
    decision,
    purchased: purchased
      ? {
          listing: purchased,
          snapshot: purchasedSnapshot?.content ?? null,
          changedSinceSnapshot: purchasedSnapshot ? listingHash(purchased) !== purchasedSnapshot.hash : null,
        }
      : null,
    verdict: getVerdict(db, id),
    webhooks: getWebhooks(db, id),
  };
}
export type MandateView = ReturnType<typeof mandateView>;

/** One row per mandate for the audit ledger. */
export function ledgerRows(db: DB) {
  return listMandates(db).map((m) => {
    const d = getDecision(db, m.id);
    const v = getVerdict(db, m.id);
    const hooks = getWebhooks(db, m.id);
    return {
      id: m.id,
      createdAt: m.createdAt,
      intent: m.rawIntent,
      scenario: m.scenario,
      status: m.status,
      ceiling: formatUsd(m.ceilingCents),
      ceilingCents: m.ceilingCents,
      totalCents: d?.totalCents ?? null,
      capturedCents: d?.capturedAmountCents ?? null,
      refunded: Boolean(v?.refundId),
      orderId: m.paypalOrderId,
      authorizationId: m.authorizationId,
      outcome: d?.outcome ?? null,
      listingId: d?.listingId ?? null,
      total: d?.totalCents != null ? formatUsd(d.totalCents) : null,
      failedRules: d?.failedRules.join(", ") || null,
      captureId: d?.captureId ?? null,
      captured: d?.capturedAmountCents != null ? formatUsd(d.capturedAmountCents) : null,
      fault: v?.fault ?? (v ? "UNDETERMINED" : null),
      confidence: v ? Math.round(v.confidence * 100) / 100 : null,
      refundId: v?.refundId ?? null,
      payoutId: v?.payoutId ?? null,
      webhooks: hooks.map((h) => h.eventType.replace(/^PAYMENT\./, "")).join(", ") || null,
      chainOk: verifyChain(getTrace(db, m.id)).ok,
    };
  });
}
export type LedgerRow = ReturnType<typeof ledgerRows>[number];
