import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/lib/db";
import { setPayPalForTests, type PayPalGateway } from "@/lib/paypal";
import { createMockPayPal, WEBHOOK_DELAY_MS } from "@/lib/paypal-mock";
import { services } from "@/lib/services";
import { extractMandate } from "@/lib/mandate";
import { SCENARIOS } from "@/lib/scenarios";
import { authorizeBudget, createBudgetOrder, fileComplaint, runMandate, simulateMerchantEdit } from "@/lib/sentinel";
import { createMandate, getDecision, getVerdict, getWebhooks, requireMandate } from "@/lib/store";
import { getTrace, verifyChain } from "@/lib/recorder";
import { freshDb, sleep } from "./helpers";

let db: DB;
let paypal: PayPalGateway;

beforeEach(() => {
  freshDb();
  setPayPalForTests(createMockPayPal());
  ({ db, paypal } = services());
});

async function authorizedMandate(scenarioKey: string, intentOverride?: string) {
  const scenario = SCENARIOS.find((s) => s.key === scenarioKey);
  const intent = intentOverride ?? scenario!.intent;
  const ex = await extractMandate(intent);
  // A custom intent is a free-form mandate: no cached scenario trace attached.
  const key = scenario && !intentOverride ? scenarioKey : null;
  const m = createMandate(db, { rawIntent: intent, rules: ex.rules, scenario: key, extractor: ex.extractor, warnings: ex.warnings });
  const { orderId } = await createBudgetOrder(db, paypal, m.id);
  await authorizeBudget(db, paypal, m.id, orderId);
  return requireMandate(db, m.id);
}

describe("end-to-end with the PayPal simulator", () => {
  it("scenario 1: safe purchase captures $51.84 and releases the rest", async () => {
    const m = await authorizedMandate("safe");
    expect(m.status).toBe("AUTHORIZED");
    expect(m.authorizedAmountCents).toBe(6000);
    const r = await runMandate(db, paypal, m.id, "cached");
    expect(r.outcome).toBe("CAPTURED");
    expect(r.policy!.failedRules).toEqual([]);
    expect(getDecision(db, m.id)).toMatchObject({ outcome: "CAPTURED", capturedAmountCents: 5184, listingId: "cam-clearview-c2" });
    expect(requireMandate(db, m.id).status).toBe("CAPTURED");
    const capture = getTrace(db, m.id).find((e) => e.type === "paypal_capture")!;
    expect(capture.payload).toMatchObject({ captured: "$51.84", released: "$8.16", finalCapture: true });
  });

  it("scenario 2: injected listing is blocked and the hold voided", async () => {
    const m = await authorizedMandate("blocked");
    const r = await runMandate(db, paypal, m.id, "cached");
    expect(r.outcome).toBe("VOIDED");
    expect(r.policy!.breakdown!.totalCents).toBe(7439);
    expect(r.policy!.failedRules).toEqual(expect.arrayContaining(["R1", "R3", "R6"]));
    expect(requireMandate(db, m.id).status).toBe("VOIDED");
    expect((await paypal.getAuthorization(m.authorizationId!)).status).toBe("VOIDED");
    const scan = getTrace(db, m.id).find((e) => e.type === "injection_scan")!;
    expect(scan.payload).toMatchObject({ flagged: true });
  });

  it("scenario 3: slipped through, agent fault, refund + bond payout", async () => {
    const m = await authorizedMandate("slipped");
    const r = await runMandate(db, paypal, m.id, "cached");
    expect(r.outcome).toBe("CAPTURED");
    expect(getDecision(db, m.id)!.capturedAmountCents).toBe(3995);

    const { verdict } = await fileComplaint(db, paypal, m.id, SCENARIOS[2].complaint!);
    expect(verdict.fault).toBe("AGENT");
    expect(verdict.outcomeStatus).toBe("SETTLED_AGENT");
    expect(verdict.refundId).toMatch(/^SIMREF/);
    expect(verdict.payoutId).toMatch(/^SIMPAYOUT/);
    expect(verdict.evidence.some((e) => e.text.includes("Windows only"))).toBe(true);
    expect(requireMandate(db, m.id).status).toBe("SETTLED_AGENT");
    expect(getVerdict(db, m.id)!.fault).toBe("AGENT");
  });

  it("merchant edits the listing after purchase: merchant fault, refund only", async () => {
    const m = await authorizedMandate("safe");
    await runMandate(db, paypal, m.id, "cached");
    simulateMerchantEdit(db, m.id);
    const { verdict } = await fileComplaint(db, paypal, m.id, "It only came with a USB-A cable.");
    expect(verdict.fault).toBe("MERCHANT");
    expect(verdict.outcomeStatus).toBe("SETTLED_MERCHANT");
    expect(verdict.refundId).toBeTruthy();
    expect(verdict.payoutId).toBeNull();
  });

  it("ambiguous instruction: user responsibility, no money moves", async () => {
    const m = await authorizedMandate("slipped", "Buy me a webcam under $60, USB-C, arriving this week, no subscriptions.");
    // No scenario attached -> rule-based shopper picks the cheapest compliant USB-C cam (Pixelon, Windows only).
    const r = await runMandate(db, paypal, m.id, "cached");
    expect(r.agent.modeUsed).toBe("heuristic");
    expect(getDecision(db, m.id)!.listingId).toBe("cam-pixelon-p1");
    const { verdict } = await fileComplaint(db, paypal, m.id, "It doesn't work with my Mac.");
    expect(verdict.fault).toBe("USER");
    expect(verdict.outcomeStatus).toBe("SETTLED_USER");
    expect(verdict.refundId).toBeNull();
  });

  it("asking for a live agent with no Gemini key falls back to the cached trace and records why", async () => {
    const m = await authorizedMandate("safe");
    const r = await runMandate(db, paypal, m.id, "live");
    expect(r.agent.modeUsed).toBe("cached");
    expect(r.agent.fallbackReason).toMatch(/no Gemini/);
    expect(getTrace(db, m.id).some((e) => e.type === "agent_fallback")).toBe(true);
  });

  it("keeps a valid hash chain across the whole lifecycle", async () => {
    const m = await authorizedMandate("slipped");
    await runMandate(db, paypal, m.id, "cached");
    await fileComplaint(db, paypal, m.id, SCENARIOS[2].complaint!);
    const trace = getTrace(db, m.id);
    expect(verifyChain(trace).ok).toBe(true);
    expect(trace.map((e) => e.type)).toEqual(
      expect.arrayContaining(["mandate_created", "order_created", "budget_authorized", "proposal", "policy_decision", "paypal_capture", "complaint", "verdict", "settlement"]),
    );
  });

  it("persists simulated webhooks and writes confirmations into the recorder", async () => {
    const m = await authorizedMandate("blocked");
    await runMandate(db, paypal, m.id, "cached");
    await sleep(WEBHOOK_DELAY_MS + 100);
    const hooks = getWebhooks(db, m.id).map((w) => w.eventType);
    expect(hooks).toEqual(expect.arrayContaining(["PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED"]));
    expect(getTrace(db, m.id).some((e) => e.type === "webhook_confirmed")).toBe(true);
    expect(verifyChain(getTrace(db, m.id)).ok).toBe(true);
  });

  it("maps payout webhooks back to the mandate", async () => {
    const m = await authorizedMandate("slipped");
    await runMandate(db, paypal, m.id, "cached");
    await fileComplaint(db, paypal, m.id, SCENARIOS[2].complaint!);
    await sleep(WEBHOOK_DELAY_MS + 100);
    expect(getWebhooks(db, m.id).map((w) => w.eventType)).toEqual(
      expect.arrayContaining(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.PAYOUTSBATCH.SUCCESS"]),
    );
  });
});

describe("guards", () => {
  it("cannot run before the budget is authorized", async () => {
    const ex = await extractMandate(SCENARIOS[0].intent);
    const m = createMandate(db, { rawIntent: "x", rules: ex.rules, scenario: "safe", extractor: "heuristic", warnings: [] });
    await expect(runMandate(db, paypal, m.id, "cached")).rejects.toMatchObject({ status: 409 });
  });

  it("runs a mandate at most once", async () => {
    const m = await authorizedMandate("safe");
    await runMandate(db, paypal, m.id, "cached");
    await expect(runMandate(db, paypal, m.id, "cached")).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an order id from a different mandate", async () => {
    const a = await authorizedMandate("safe");
    const ex = await extractMandate(SCENARIOS[0].intent);
    const b = createMandate(db, { rawIntent: "x", rules: ex.rules, scenario: null, extractor: "heuristic", warnings: [] });
    await createBudgetOrder(db, paypal, b.id);
    await expect(authorizeBudget(db, paypal, b.id, a.paypalOrderId!)).rejects.toMatchObject({ status: 400 });
  });

  it("only captured purchases can be disputed, and only once", async () => {
    const blocked = await authorizedMandate("blocked");
    await runMandate(db, paypal, blocked.id, "cached");
    await expect(fileComplaint(db, paypal, blocked.id, "x")).rejects.toMatchObject({ status: 409 });

    const safe = await authorizedMandate("safe");
    await runMandate(db, paypal, safe.id, "cached");
    await fileComplaint(db, paypal, safe.id, "meh");
    await expect(fileComplaint(db, paypal, safe.id, "again")).rejects.toMatchObject({ status: 409 });
  });

  it("voids the hold when the agent proposes nothing", async () => {
    const m = await authorizedMandate("none", "Buy me headphones under $20, arriving this week");
    const r = await runMandate(db, paypal, m.id, "cached");
    expect(r.outcome).toBe("VOIDED");
    expect(getDecision(db, m.id)!.failedRules).toEqual(["NO_PROPOSAL"]);
    expect((await paypal.getAuthorization(m.authorizationId!)).status).toBe("VOIDED");
  });
});
