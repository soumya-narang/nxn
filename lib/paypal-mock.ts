import { randomBytes } from "node:crypto";
import type { PayPalGateway, WebhookEvent } from "./paypal";
import { PayPalError } from "./paypal";

/**
 * SIMULATED PayPal, used only when no sandbox credentials are configured.
 * It mirrors the sandbox state machine closely enough to exercise Sentinel:
 * authorize, partial final capture (rest released), void, refund, payout, and
 * the webhooks those fire. No network calls; nothing here is real PayPal.
 */

type AuthStatus = "CREATED" | "CAPTURED" | "VOIDED" | "EXPIRED";

interface MockOrder {
  id: string;
  customId: string;
  amountCents: number;
  status: "CREATED" | "COMPLETED";
  authorizationId?: string;
}
interface MockAuth {
  id: string;
  orderId: string;
  customId: string;
  amountCents: number;
  status: AuthStatus;
  expiresAt: string;
}
interface MockCapture {
  id: string;
  authorizationId: string;
  customId: string;
  amountCents: number;
  refundedCents: number;
}

export type MockWebhookListener = (event: WebhookEvent) => void;

const listeners = new Set<MockWebhookListener>();
/** Lets the app persist the simulated webhooks the same way as real ones. */
export function onMockWebhook(listener: MockWebhookListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const WEBHOOK_DELAY_MS = 300;

const rid = (prefix: string) => `${prefix}${randomBytes(8).toString("hex").toUpperCase()}`;

export function createMockPayPal(): PayPalGateway & { _state: { orders: Map<string, MockOrder>; auths: Map<string, MockAuth> } } {
  const orders = new Map<string, MockOrder>();
  const auths = new Map<string, MockAuth>();
  const captures = new Map<string, MockCapture>();
  const idempotency = new Map<string, unknown>();

  // Like the real thing, webhooks arrive shortly *after* the API call returns.
  const emit = (event_type: string, resource: Record<string, unknown>) => {
    const event: WebhookEvent = { id: rid("WH-SIM-"), event_type, resource: resource as WebhookEvent["resource"] };
    setTimeout(() => {
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          /* a listener failure must not break the payment flow */
        }
      }
    }, WEBHOOK_DELAY_MS);
  };

  function once<T>(key: string | undefined, fn: () => T): T {
    if (key && idempotency.has(key)) return idempotency.get(key) as T;
    const r = fn();
    if (key) idempotency.set(key, r);
    return r;
  }

  function getAuth(id: string): MockAuth {
    const a = auths.get(id);
    if (!a) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Authorization ${id} not found`);
    if (a.status === "CREATED" && new Date(a.expiresAt).getTime() < Date.now()) a.status = "EXPIRED";
    return a;
  }

  return {
    mode: "mock",
    _state: { orders, auths },

    async createAuthorizeOrder({ mandateId, amountCents }) {
      return once(`order-${mandateId}`, () => {
        const order: MockOrder = { id: rid("SIMORD"), customId: mandateId, amountCents, status: "CREATED" };
        orders.set(order.id, order);
        return { orderId: order.id };
      });
    },

    async authorizeOrder(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Order ${orderId} not found`);
      if (order.authorizationId) {
        const a = auths.get(order.authorizationId)!;
        return { authorizationId: a.id, status: a.status, amountCents: a.amountCents, expiresAt: a.expiresAt, customId: a.customId };
      }
      // The simulator treats the order as approved by the buyer.
      const auth: MockAuth = {
        id: rid("SIMAUTH"),
        orderId,
        customId: order.customId,
        amountCents: order.amountCents,
        status: "CREATED",
        expiresAt: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
      };
      auths.set(auth.id, auth);
      order.status = "COMPLETED";
      order.authorizationId = auth.id;
      emit("PAYMENT.AUTHORIZATION.CREATED", { id: auth.id, custom_id: auth.customId, status: auth.status });
      return { authorizationId: auth.id, status: auth.status, amountCents: auth.amountCents, expiresAt: auth.expiresAt, customId: auth.customId };
    },

    async getAuthorization(id) {
      const a = getAuth(id);
      return { status: a.status, amountCents: a.amountCents, expiresAt: a.expiresAt };
    },

    async captureAuthorization({ authorizationId, amountCents, requestId }) {
      return once(requestId, () => {
        const a = getAuth(authorizationId);
        if (a.status !== "CREATED")
          throw new PayPalError(422, "UNPROCESSABLE_ENTITY", `AUTHORIZATION_ALREADY_${a.status}: authorization is ${a.status}`);
        if (amountCents > a.amountCents)
          throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED: capture exceeds authorized amount");
        // final_capture: true -> the remainder of the hold is released.
        a.status = "CAPTURED";
        const cap: MockCapture = { id: rid("SIMCAP"), authorizationId, customId: a.customId, amountCents, refundedCents: 0 };
        captures.set(cap.id, cap);
        emit("PAYMENT.CAPTURE.COMPLETED", { id: cap.id, custom_id: cap.customId, status: "COMPLETED" });
        return { captureId: cap.id, status: "COMPLETED", amountCents };
      });
    },

    async voidAuthorization({ authorizationId, requestId }) {
      return once(requestId, () => {
        const a = getAuth(authorizationId);
        if (a.status !== "CREATED")
          throw new PayPalError(422, "UNPROCESSABLE_ENTITY", `PREVIOUSLY_${a.status}: authorization is ${a.status}`);
        a.status = "VOIDED";
        emit("PAYMENT.AUTHORIZATION.VOIDED", { id: a.id, custom_id: a.customId, status: "VOIDED" });
        return { status: "VOIDED" };
      });
    },

    async refundCapture({ captureId, amountCents, requestId }) {
      return once(requestId, () => {
        const c = captures.get(captureId);
        if (!c) throw new PayPalError(404, "RESOURCE_NOT_FOUND", `Capture ${captureId} not found`);
        if (c.refundedCents + amountCents > c.amountCents)
          throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED: refund exceeds captured amount");
        c.refundedCents += amountCents;
        const refundId = rid("SIMREF");
        emit("PAYMENT.CAPTURE.REFUNDED", { id: refundId, custom_id: c.customId, status: "COMPLETED", capture_id: c.id });
        return { refundId, status: "COMPLETED" };
      });
    },

    async operatorPayout({ senderBatchId }) {
      return once(senderBatchId, () => {
        const id = rid("SIMPAYOUT");
        // Same shape as the real PAYMENT.PAYOUTSBATCH.SUCCESS resource.
        emit("PAYMENT.PAYOUTSBATCH.SUCCESS", {
          batch_header: { payout_batch_id: id, batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: senderBatchId } },
        });
        return { payoutBatchId: id, status: "SUCCESS" };
      });
    },

    async verifyWebhook() {
      // Simulated events never come over HTTP, so nothing posted to the
      // webhook endpoint can be verified while running the simulator.
      return false;
    },
  };
}
