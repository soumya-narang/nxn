import { z } from "zod";
import { handle, readJson } from "@/lib/http";
import { services } from "@/lib/services";
import { extractMandate } from "@/lib/mandate";
import { createMandate } from "@/lib/store";
import { getScenario } from "@/lib/scenarios";

export const dynamic = "force-dynamic";

const Body = z.object({
  intent: z.string().trim().min(3).max(500),
  scenario: z.enum(["safe", "blocked", "slipped"]).nullish(),
});

/** POST: extract a mandate from plain-language intent. Returns a DRAFT the user can edit. */
export const POST = handle(async (req: Request) => {
  const { intent, scenario } = await readJson(req, Body);
  const { db } = services();
  // A scenario's cached trace only makes sense for that scenario's exact intent.
  const key = scenario && getScenario(scenario)?.intent === intent ? scenario : null;
  const extraction = await extractMandate(intent);
  const mandate = createMandate(db, { rawIntent: intent, rules: extraction.rules, scenario: key, extractor: extraction.extractor, warnings: extraction.warnings });
  return { mandate, warnings: extraction.warnings };
});
