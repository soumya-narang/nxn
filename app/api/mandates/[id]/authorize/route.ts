import { z } from "zod";
import { handle, readJson, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { authorizeBudget } from "@/lib/sentinel";

export const dynamic = "force-dynamic";

/** POST: after the buyer approves in PayPal, place the hold and store the authorization id. */
export const POST = handle(async (req: Request, { params }: IdParams) => {
  const { id } = await params;
  const { orderId } = await readJson(req, z.object({ orderId: z.string().min(1).max(64) }));
  const { db, paypal } = services();
  return { mandate: await authorizeBudget(db, paypal, id, orderId) };
});
