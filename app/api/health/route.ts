import { handle } from "@/lib/http";
import { services } from "@/lib/services";
import { modelName } from "@/lib/llm";

export const dynamic = "force-dynamic";

/** GET: liveness for the host, plus which integrations are live vs simulated. Never returns secrets. */
export const GET = handle(async () => {
  const { db, paypal } = services();
  db.prepare("SELECT 1").get();
  return {
    ok: true,
    paypal: paypal.mode,
    webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID),
    payoutConfigured: Boolean(process.env.PAYPAL_OPERATOR_CLIENT_ID && process.env.PAYPAL_MERCHANT_EMAIL),
    llm: modelName(),
  };
});
