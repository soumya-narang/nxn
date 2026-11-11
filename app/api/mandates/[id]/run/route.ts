import { z } from "zod";
import { handle, readJson, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { runMandate } from "@/lib/sentinel";
import { llmAvailable } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST: run the agent, gate its proposal through R1-R7, then capture or void. */
export const POST = handle(async (req: Request, { params }: IdParams) => {
  const { id } = await params;
  const { agentMode } = await readJson(req, z.object({ agentMode: z.enum(["live", "cached"]).optional() }));
  const { db, paypal } = services();
  const mode = agentMode ?? (llmAvailable() ? "live" : "cached");
  const r = await runMandate(db, paypal, id, mode);
  return { outcome: r.outcome, captureId: r.captureId, agentMode: r.agent.modeUsed, fallbackReason: r.agent.fallbackReason ?? null, failedRules: r.policy?.failedRules ?? [] };
});
