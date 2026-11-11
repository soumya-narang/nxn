import { handle, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { createBudgetOrder } from "@/lib/sentinel";

export const dynamic = "force-dynamic";

/** POST: create the PayPal order with intent AUTHORIZE for the budget ceiling. */
export const POST = handle(async (_req: Request, { params }: IdParams) => {
  const { id } = await params;
  const { db, paypal } = services();
  return createBudgetOrder(db, paypal, id);
});
