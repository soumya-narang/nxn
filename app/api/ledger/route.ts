import { handle } from "@/lib/http";
import { services } from "@/lib/services";
import { ledgerRows } from "@/lib/view";

export const dynamic = "force-dynamic";

/** GET: one row per mandate: decision, PayPal ids, verdict. */
export const GET = handle(async () => ({ rows: ledgerRows(services().db) }));
