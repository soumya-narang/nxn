import { handle, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { simulateMerchantEdit } from "@/lib/sentinel";

export const dynamic = "force-dynamic";

/** POST (demo only): the fictional merchant edits the purchased listing after the sale. */
export const POST = handle(async (_req: Request, { params }: IdParams) => {
  const { id } = await params;
  return { listing: simulateMerchantEdit(services().db, id) };
});
