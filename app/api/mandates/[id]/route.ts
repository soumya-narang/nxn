import { z } from "zod";
import { handle, readJson, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { MandateRules } from "@/lib/mandate";
import { updateMandateRules } from "@/lib/store";
import { mandateView } from "@/lib/view";

export const dynamic = "force-dynamic";

/** GET: full state of one mandate (trace, decision, verdict, webhooks). */
export const GET = handle(async (_req: Request, { params }: IdParams) => {
  const { id } = await params;
  return mandateView(services().db, id);
});

/** PATCH: the user edits the extracted rules before approving the budget. */
export const PATCH = handle(async (req: Request, { params }: IdParams) => {
  const { id } = await params;
  const { rules } = await readJson(req, z.object({ rules: MandateRules }));
  return { mandate: updateMandateRules(services().db, id, rules) };
});
