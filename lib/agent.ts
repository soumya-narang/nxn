import { z } from "zod";
import { generateText, tool, stepCountIs, type StopCondition, type ToolSet } from "ai";
import type { DB } from "./db";
import { computeTotal, getListing, searchCatalog, summarize, type Listing } from "./catalog";
import { getModel } from "./llm";
import type { Mandate } from "./store";
import type { Proposal } from "./policy";
import { appendEvent, snapshotListing } from "./recorder";
import { shortError } from "./mandate";
import { SCENARIO_SCRIPTS, type ScriptStep } from "./scenarios";
import { formatUsd } from "./util";

/**
 * Shopping agent. UNTRUSTED: it can search the catalog, read listings and
 * propose a purchase, nothing else. It never sees PayPal credentials and has
 * no tool that moves money. Every step goes into the flight recorder.
 */

export type AgentMode = "live" | "cached";

export interface AgentRun {
  proposal: Proposal | null;
  modeUsed: AgentMode | "heuristic";
  fallbackReason?: string;
}

const MAX_STEPS = 8;

/** The three tools, executed server-side against the real catalog and recorder. */
export class AgentTools {
  proposal: Proposal | null = null;
  constructor(
    private db: DB,
    private mandate: Mandate,
  ) {}

  searchCatalog(input: { query: string; maxPriceUsd?: number }) {
    appendEvent(this.db, this.mandate.id, "tool_call", { tool: "search_catalog", input });
    const results = searchCatalog(this.db, {
      query: input.query,
      category: this.mandate.rules.category,
      maxPriceCents: input.maxPriceUsd !== undefined ? Math.round(input.maxPriceUsd * 100) : undefined,
    });
    appendEvent(this.db, this.mandate.id, "tool_result", { tool: "search_catalog", count: results.length, results });
    return results;
  }

  getListing(input: { listingId: string }): Listing | { error: string } {
    appendEvent(this.db, this.mandate.id, "tool_call", { tool: "get_listing", input });
    const listing = getListing(this.db, input.listingId);
    if (!listing) {
      appendEvent(this.db, this.mandate.id, "tool_result", { tool: "get_listing", error: "not found" });
      return { error: `No listing with id ${input.listingId}` };
    }
    // Snapshot exactly what the agent is shown.
    const snap = snapshotListing(this.db, this.mandate.id, listing);
    appendEvent(this.db, this.mandate.id, "tool_result", { tool: "get_listing", listing: summarize(listing), snapshotHash: snap.hash });
    return listing;
  }

  proposePurchase(input: { listingId: string; addOnIds: string[]; rationale: string }) {
    appendEvent(this.db, this.mandate.id, "tool_call", { tool: "propose_purchase", input });
    if (this.proposal) {
      appendEvent(this.db, this.mandate.id, "tool_result", { tool: "propose_purchase", ignored: "a proposal was already submitted" });
      return { status: "ignored", message: "Only one proposal is allowed per mandate." };
    }
    this.proposal = { listingId: input.listingId, addOnIds: input.addOnIds ?? [], rationale: input.rationale };
    appendEvent(this.db, this.mandate.id, "proposal", this.proposal);
    appendEvent(this.db, this.mandate.id, "tool_result", { tool: "propose_purchase", status: "submitted" });
    return { status: "submitted", message: "Proposal sent to Sentinel. Sentinel decides whether payment is captured. You are done." };
  }

  say(text: string) {
    appendEvent(this.db, this.mandate.id, "agent_message", { text });
  }
}

export async function runAgent(db: DB, mandate: Mandate, requested: AgentMode): Promise<AgentRun> {
  appendEvent(db, mandate.id, "agent_started", { requestedMode: requested });
  const model = requested === "live" ? getModel() : null;

  if (model) {
    const tools = new AgentTools(db, mandate);
    try {
      await runLiveAgent(model, tools, mandate);
      return { proposal: tools.proposal, modeUsed: "live" };
    } catch (err) {
      if (tools.proposal) return { proposal: tools.proposal, modeUsed: "live" };
      const reason = shortError(err);
      appendEvent(db, mandate.id, "agent_fallback", { reason, to: mandate.scenario ? "cached" : "heuristic" });
      return { ...runOffline(db, mandate), fallbackReason: reason };
    }
  }
  if (requested === "live") {
    appendEvent(db, mandate.id, "agent_fallback", { reason: "no Gemini API key configured", to: mandate.scenario ? "cached" : "heuristic" });
    return { ...runOffline(db, mandate), fallbackReason: "no Gemini API key configured" };
  }
  return runOffline(db, mandate);
}

/** Cached trace for demo scenarios, heuristic shopper for anything else. */
function runOffline(db: DB, mandate: Mandate): AgentRun {
  const tools = new AgentTools(db, mandate);
  const script = mandate.scenario ? SCENARIO_SCRIPTS[mandate.scenario] : undefined;
  if (script) {
    runScript(tools, script);
    return { proposal: tools.proposal, modeUsed: "cached" };
  }
  runHeuristic(tools, mandate);
  return { proposal: tools.proposal, modeUsed: "heuristic" };
}

/**
 * Replays a cached agent trace. The *decisions* are cached; every tool call
 * still runs for real, so snapshots, hashes and the policy check are live.
 */
export function runScript(tools: AgentTools, script: ScriptStep[]) {
  for (const step of script) {
    if ("say" in step) tools.say(step.say);
    else if (step.tool === "search_catalog") tools.searchCatalog(step.input);
    else if (step.tool === "get_listing") tools.getListing(step.input);
    else if (step.tool === "propose_purchase") tools.proposePurchase(step.input);
  }
}

/** A reasonable non-LLM shopper: cheapest listing that satisfies the mandate as written. */
export function runHeuristic(tools: AgentTools, mandate: Mandate) {
  const r = mandate.rules;
  tools.say(`Searching ${r.category} listings up to ${formatUsd(r.ceilingCents)} (rule-based shopper, no LLM).`);
  const results = tools.searchCatalog({ query: r.category, maxPriceUsd: r.ceilingCents / 100 });
  const candidates = [...results].sort((a, b) => Number(a.price.slice(1)) - Number(b.price.slice(1)));
  for (const c of candidates) {
    const listing = tools.getListing({ listingId: c.id });
    if ("error" in listing) continue;
    const total = computeTotal(listing, []).totalCents;
    const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
    const reasons: string[] = [];
    if (total > r.ceilingCents) reasons.push(`total ${formatUsd(total)} is over budget`);
    if (r.maxDeliveryDays !== null && listing.deliveryDays > r.maxDeliveryDays) reasons.push(`delivery ${listing.deliveryDays} days is too slow`);
    const missing = r.requiredFeatures.filter((f) => !lower(listing.features).includes(f.toLowerCase()));
    if (missing.length) reasons.push(`missing ${missing.join(", ")}`);
    const incompatible = r.compatibility.filter((p) => !lower(listing.compatibility).includes(p.toLowerCase()));
    if (incompatible.length) reasons.push(`not compatible with ${incompatible.join(", ")}`);
    if (reasons.length) {
      tools.say(`Skipping ${listing.title}: ${reasons.join("; ")}.`);
      continue;
    }
    tools.say(`Choosing ${listing.title} at ${formatUsd(total)} including tax and shipping, no add-ons.`);
    tools.proposePurchase({ listingId: listing.id, addOnIds: [], rationale: "Cheapest listing that meets every stated constraint." });
    return;
  }
  tools.say("No listing satisfies the mandate. Not proposing a purchase.");
}

async function runLiveAgent(model: NonNullable<ReturnType<typeof getModel>>, tools: AgentTools, mandate: Mandate) {
  const toolset = {
    search_catalog: tool({
      description: "Search the store catalog. Returns listing summaries (no full description).",
      inputSchema: z.object({
        query: z.string().describe("Search keywords"),
        maxPriceUsd: z.number().optional().describe("Optional maximum item price in USD"),
      }),
      execute: async (input) => tools.searchCatalog(input),
    }),
    get_listing: tool({
      description: "Get the full listing for one product, including description, compatibility and optional add-ons. You must read a listing before proposing it.",
      inputSchema: z.object({ listingId: z.string() }),
      execute: async (input) => tools.getListing(input),
    }),
    propose_purchase: tool({
      description: "Propose exactly one purchase to Sentinel. You cannot pay; Sentinel checks the proposal and decides. Call this once, at the end.",
      inputSchema: z.object({
        listingId: z.string(),
        addOnIds: z.array(z.string()).describe("Ids of optional add-ons to include; usually empty"),
        rationale: z.string().describe("One or two sentences on why this listing fits the mandate"),
      }),
      execute: async (input) => tools.proposePurchase(input),
    }),
  } satisfies ToolSet;

  const proposed: StopCondition<typeof toolset> = ({ steps }) =>
    steps.some((s) => s.toolCalls.some((c) => c.toolName === "propose_purchase"));

  const result = await generateText({
    model,
    tools: toolset,
    maxRetries: 1,
    timeout: 60_000,
    stopWhen: [proposed, stepCountIs(MAX_STEPS)],
    system:
      "You are a shopping agent buying one product for a user from an online store. " +
      "Use search_catalog, then get_listing on the candidates you consider, then call propose_purchase exactly once. " +
      "Pick the best listing for the user's mandate. Keep any text you write short.",
    prompt: `The user's request: "${mandate.rawIntent}"\n\nThe approved mandate:\n${JSON.stringify(
      { ...mandate.rules, ceiling: formatUsd(mandate.rules.ceilingCents) },
      null,
      2,
    )}`,
    onStepEnd: (step) => {
      const text = step.text?.trim();
      if (text) tools.say(text);
    },
  });
  if (!tools.proposal && result.text?.trim()) tools.say(result.text.trim());
}
