import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/lib/db";
import { evaluatePolicy, type AuthorizationState, type PolicyInput } from "@/lib/policy";
import { snapshotListing, type Snapshot } from "@/lib/recorder";
import { applyMerchantEdit, computeTotal } from "@/lib/catalog";
import { scanPatterns, listingText } from "@/lib/injection";
import { freshDb, listing, mandate, rules } from "./helpers";

let db: DB;
let mandateId: string;
const auth: AuthorizationState = { status: "CREATED", amountCents: 6000, expiresAt: new Date(Date.now() + 86400_000).toISOString() };

function input(listingId: string, addOnIds: string[] = [], over: Partial<PolicyInput> = {}): PolicyInput {
  const l = listing(db, listingId);
  const snapshot: Snapshot = snapshotListing(db, mandateId, l);
  return {
    rules: rules(),
    proposal: { listingId, addOnIds },
    listing: l,
    snapshot,
    injectionFlagged: scanPatterns(listingText(l)).length > 0,
    authorization: auth,
    ...over,
  };
}

const failed = (i: PolicyInput) => evaluatePolicy(i).failedRules;

beforeEach(() => {
  db = freshDb();
  mandateId = mandate(db).id;
});

describe("server-side totals", () => {
  it("matches the README demo numbers", () => {
    expect(computeTotal(listing(db, "cam-clearview-c2"), []).totalCents).toBe(5184);
    expect(computeTotal(listing(db, "mic-echoline-pro"), ["PP-ECHO-2Y"]).totalCents).toBe(7439);
    expect(computeTotal(listing(db, "cam-pixelon-p1"), []).totalCents).toBe(3995);
  });
});

describe("policy engine R1-R7", () => {
  it("passes a clean in-budget purchase and captures the computed total", () => {
    const d = evaluatePolicy(input("cam-clearview-c2"));
    expect(d.pass).toBe(true);
    expect(d.failedRules).toEqual([]);
    expect(d.captureAmountCents).toBe(5184);
    expect(d.results.map((r) => r.rule)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  });

  it("blocks the injected protection-plan purchase on R1, R3 and R6 (and R7: $74.39 exceeds the $60 hold)", () => {
    const d = evaluatePolicy({ ...input("mic-echoline-pro", ["PP-ECHO-2Y"]), rules: rules({ category: "microphone" }) });
    expect(d.pass).toBe(false);
    expect(d.failedRules).toEqual(["R1", "R3", "R6", "R7"]);
    expect(d.captureAmountCents).toBeNull();
  });

  it("R1 fails when shipping + tax push an in-price item over the ceiling", () => {
    expect(failed(input("cam-clearview-c2", [], { rules: rules({ ceilingCents: 5000 }) }))).toContain("R1");
  });

  it("R2 fails on the wrong category", () => {
    expect(failed(input("mic-quill-q2"))).toEqual(["R2"]);
  });

  it("R3 fails on a subscription add-on even when cheap enough", () => {
    expect(failed(input("cam-vantage-ai", ["SUB-VANTAGE-CLOUD"]))).toEqual(["R3"]);
  });

  it("R3 allows one-off accessories", () => {
    expect(failed(input("cam-clearview-c2", ["ACC-TRIPOD"], { rules: rules({ ceilingCents: 7000 }), authorization: { ...auth, amountCents: 7000 } }))).toEqual([]);
  });

  it("R4 enforces the allowed seller list", () => {
    expect(failed(input("cam-pixelon-p1", [], { rules: rules({ allowedSellers: ["sel-larkspur"] }) }))).toEqual(["R4"]);
    expect(failed(input("cam-clearview-c2", [], { rules: rules({ allowedSellers: ["sel-larkspur"] }) }))).toEqual([]);
  });

  it("R4 fails when the seller changed since the snapshot", () => {
    const i = input("cam-clearview-c2");
    const swapped = { ...i.listing!, seller: { id: "sel-northpeak", name: "Northpeak Imports" } };
    expect(failed({ ...i, listing: swapped })).toEqual(expect.arrayContaining(["R4", "R6"]));
  });

  it("R5 fails on slow delivery, passes with no deadline", () => {
    expect(failed(input("cam-northpeak-n5"))).toEqual(["R5"]);
    expect(failed(input("cam-northpeak-n5", [], { rules: rules({ maxDeliveryDays: null }) }))).toEqual([]);
  });

  it("R6 fails without a snapshot (agent never looked)", () => {
    expect(failed({ ...input("cam-clearview-c2"), snapshot: null })).toEqual(expect.arrayContaining(["R6"]));
  });

  it("R6 fails when the listing changed after the agent's snapshot", () => {
    const i = input("cam-clearview-c2");
    const edited = applyMerchantEdit(db, "cam-clearview-c2", { description: "changed" });
    expect(failed({ ...i, listing: edited })).toEqual(["R6"]);
  });

  it("R6 fails on unknown add-on ids", () => {
    expect(failed(input("cam-clearview-c2", ["FREE-MONEY"]))).toEqual(["R6"]);
  });

  it("R7 fails on a voided, expired or too-small authorization", () => {
    expect(failed(input("cam-clearview-c2", [], { authorization: { ...auth, status: "VOIDED" } }))).toEqual(["R7"]);
    expect(failed(input("cam-clearview-c2", [], { authorization: { ...auth, expiresAt: new Date(Date.now() - 1000).toISOString() } }))).toEqual(["R7"]);
    expect(failed(input("cam-clearview-c2", [], { authorization: { ...auth, amountCents: 5000 } }))).toEqual(["R7"]);
  });

  it("fails every rule for a listing that does not exist", () => {
    const d = evaluatePolicy({ ...input("cam-clearview-c2"), listing: null, proposal: { listingId: "nope", addOnIds: [] } });
    expect(d.failedRules).toHaveLength(7);
  });
});
