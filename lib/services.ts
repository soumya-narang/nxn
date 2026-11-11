import { getDb, type DB } from "./db";
import { getPayPal, type PayPalGateway } from "./paypal";
import { onMockWebhook } from "./paypal-mock";
import { ingestWebhook } from "./store";

const g = globalThis as unknown as { __sentinelMockHook?: boolean };

/** Shared server-side services. Simulated PayPal webhooks are persisted like real ones. */
export function services(): { db: DB; paypal: PayPalGateway } {
  const db = getDb();
  const paypal = getPayPal();
  if (paypal.mode === "mock" && !g.__sentinelMockHook) {
    g.__sentinelMockHook = true;
    onMockWebhook((event) => ingestWebhook(getDb(), event, true, true));
  }
  return { db, paypal };
}
