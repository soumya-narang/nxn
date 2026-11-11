import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { services } from "@/lib/services";
import { ingestWebhook } from "@/lib/store";
import type { WebhookEvent } from "@/lib/paypal";

export const dynamic = "force-dynamic";

/**
 * POST: PayPal webhooks. Each event is verified with
 * /v1/notifications/verify-webhook-signature before it is trusted. Unverified
 * events are stored (for the audit trail) but never confirm anything.
 */
export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event?.id || !event?.event_type) return NextResponse.json({ error: "Not a PayPal event" }, { status: 400 });

  const { db, paypal } = services();
  let verified = false;
  try {
    verified = await paypal.verifyWebhook(req.headers, event);
  } catch (err) {
    console.error("[sentinel] webhook verification error", err);
  }
  const { duplicate, mandateId } = ingestWebhook(db, event, verified, false);
  // 200 even when unverified so PayPal does not retry a forged event forever.
  return { received: true, verified, duplicate, mandateId };
});
