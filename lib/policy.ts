import { computeTotal, listingHash, type Listing, type PriceBreakdown } from "./catalog";
import type { MandateRules } from "./mandate";
import type { Snapshot } from "./recorder";
import { formatUsd } from "./util";

/**
 * Policy engine: plain TypeScript, no LLM. Decides whether money moves.
 * Everything it reads is server-side state (catalog, snapshot, PayPal's view of
 * the authorization); the agent contributes only a listing id and add-on ids.
 */

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

export const RULE_NAMES: Record<RuleId, string> = {
  R1: "Budget",
  R2: "Category",
  R3: "No recurring charges",
  R4: "Seller",
  R5: "Delivery",
  R6: "Integrity",
  R7: "Authorization",
};

export interface RuleResult {
  rule: RuleId;
  name: string;
  pass: boolean;
  detail: string;
}

export interface Proposal {
  listingId: string;
  addOnIds: string[];
  rationale?: string;
}

export interface AuthorizationState {
  status: string; // PayPal authorization status
  amountCents: number;
  expiresAt: string | null;
}

export interface PolicyInput {
  rules: MandateRules;
  proposal: Proposal;
  listing: Listing | null; // current listing, read server-side
  snapshot: Snapshot | null; // what the agent saw
  injectionFlagged: boolean;
  authorization: AuthorizationState;
  now?: Date;
}

export interface PolicyDecision {
  pass: boolean;
  results: RuleResult[];
  failedRules: RuleId[];
  breakdown: PriceBreakdown | null;
  captureAmountCents: number | null;
}

const RECURRING_KINDS = new Set(["protection_plan", "subscription"]);

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { rules, proposal, listing, snapshot, authorization } = input;
  const now = input.now ?? new Date();
  const results: RuleResult[] = [];
  const add = (rule: RuleId, pass: boolean, detail: string) => results.push({ rule, name: RULE_NAMES[rule], pass, detail });

  if (!listing) {
    const msg = `Listing ${proposal.listingId} does not exist in the catalog`;
    (Object.keys(RULE_NAMES) as RuleId[]).forEach((r) => add(r, false, msg));
    return finish(results, null);
  }

  const breakdown = computeTotal(listing, proposal.addOnIds);
  const total = breakdown.totalCents;

  // R1 Budget: server-computed total within the mandate ceiling.
  add(
    "R1",
    total <= rules.ceilingCents,
    `Total ${formatUsd(total)} (item ${formatUsd(breakdown.itemCents)} + shipping ${formatUsd(breakdown.shippingCents)} + tax ${formatUsd(
      breakdown.taxCents,
    )} + add-ons ${formatUsd(breakdown.addOnsCents)}) vs ceiling ${formatUsd(rules.ceilingCents)}`,
  );

  // R2 Category.
  add("R2", listing.category === rules.category, `Listing category "${listing.category}" vs mandate "${rules.category}"`);

  // R3 No recurring charges: no subscription or protection-plan line.
  const selected = proposal.addOnIds.map((id) => listing.addOns.find((a) => a.id === id)).filter(Boolean) as Listing["addOns"];
  const recurring = selected.filter((a) => a.recurring || RECURRING_KINDS.has(a.kind));
  const r3Fail = recurring.length > 0 || listing.recurring;
  add(
    "R3",
    !r3Fail,
    r3Fail
      ? `Recurring line(s): ${[...(listing.recurring ? [listing.title] : []), ...recurring.map((a) => `${a.name} (${a.recurring ?? a.kind})`)].join(", ")}`
      : "No subscription or protection-plan lines",
  );

  // R4 Seller: on the allowed list, or unchanged from what the agent saw.
  if (rules.allowedSellers.length > 0) {
    const ok = rules.allowedSellers.includes(listing.seller.id);
    add("R4", ok, `Seller ${listing.seller.id} ${ok ? "is" : "is not"} on the allowed list (${rules.allowedSellers.join(", ")})`);
  } else {
    const ok = !!snapshot && snapshot.content.seller.id === listing.seller.id;
    add(
      "R4",
      ok,
      snapshot ? `Seller ${listing.seller.id} vs snapshot seller ${snapshot.content.seller.id}` : "No snapshot to compare the seller against",
    );
  }

  // R5 Delivery.
  if (rules.maxDeliveryDays === null) add("R5", true, "No delivery deadline in the mandate");
  else
    add(
      "R5",
      listing.deliveryDays <= rules.maxDeliveryDays,
      `Delivery estimate ${listing.deliveryDays} day(s) vs deadline ${rules.maxDeliveryDays} day(s)`,
    );

  // R6 Integrity: no injection flag; proposal matches the snapshot the agent saw.
  const problems: string[] = [];
  if (input.injectionFlagged) problems.push("listing text flagged by the injection scanner");
  if (!snapshot) problems.push("agent never viewed this listing (no snapshot)");
  else if (snapshot.hash !== listingHash(listing)) problems.push("listing changed since the agent's snapshot");
  if (breakdown.unknownAddOns.length) problems.push(`unknown add-on(s): ${breakdown.unknownAddOns.join(", ")}`);
  add("R6", problems.length === 0, problems.length ? problems.join("; ") : "No injection flag; listing matches snapshot hash");

  // R7 Authorization: capture within the authorized amount; authorization still valid.
  const authProblems: string[] = [];
  if (authorization.status !== "CREATED") authProblems.push(`authorization status is ${authorization.status}`);
  if (authorization.expiresAt && new Date(authorization.expiresAt).getTime() <= now.getTime()) authProblems.push("authorization expired");
  if (total > authorization.amountCents) authProblems.push(`${formatUsd(total)} exceeds authorized ${formatUsd(authorization.amountCents)}`);
  add(
    "R7",
    authProblems.length === 0,
    authProblems.length ? authProblems.join("; ") : `Capture ${formatUsd(total)} within authorized ${formatUsd(authorization.amountCents)}; authorization valid`,
  );

  return finish(results, breakdown);
}

function finish(results: RuleResult[], breakdown: PriceBreakdown | null): PolicyDecision {
  const failedRules = results.filter((r) => !r.pass).map((r) => r.rule);
  const pass = failedRules.length === 0;
  return { pass, results, failedRules, breakdown, captureAmountCents: pass && breakdown ? breakdown.totalCents : null };
}
