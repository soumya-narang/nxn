import { z } from "zod";
import { handle, readJson, type IdParams } from "@/lib/http";
import { services } from "@/lib/services";
import { fileComplaint } from "@/lib/sentinel";

export const dynamic = "force-dynamic";

/** POST: "this isn't what I asked for" -> arbiter verdict -> settlement. */
export const POST = handle(async (req: Request, { params }: IdParams) => {
  const { id } = await params;
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(3).max(1000) }));
  const { db, paypal } = services();
  const { verdict } = await fileComplaint(db, paypal, id, text);
  return { verdict };
});
