import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxPayPal, paypalMode, PayPalError, SANDBOX_API } from "@/lib/paypal";
import { createMockPayPal } from "@/lib/paypal-mock";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responder: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const raw = init.body as string | undefined;
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers,
      body: raw && headers["Content-Type"] === "application/json" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const r = url.endsWith("/v1/oauth2/token") ? { json: { access_token: "tok", expires_in: 3600 } } : responder(call);
    const status = r.status ?? 200;
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ENV = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_OPERATOR_CLIENT_ID", "PAYPAL_OPERATOR_CLIENT_SECRET", "PAYPAL_MODE", "PAYPAL_WEBHOOK_ID"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.PAYPAL_CLIENT_ID = "merchant-id";
  process.env.PAYPAL_CLIENT_SECRET = "merchant-secret";
  process.env.PAYPAL_OPERATOR_CLIENT_ID = "op-id";
  process.env.PAYPAL_OPERATOR_CLIENT_SECRET = "op-secret";
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
});

describe("PayPal sandbox client (request shaping)", () => {
  it("creates an AUTHORIZE order carrying the mandate id", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { id: "ORDER1" } }));
    const pp = createSandboxPayPal({ fetchFn: fn });
    expect(await pp.createAuthorizeOrder({ mandateId: "mdt_1", amountCents: 6000, description: "webcam" })).toEqual({ orderId: "ORDER1" });
    const [token, order] = calls;
    expect(token.url).toBe(`${SANDBOX_API}/v1/oauth2/token`);
    expect(token.headers.Authorization).toBe(`Basic ${Buffer.from("merchant-id:merchant-secret").toString("base64")}`);
    expect(order.url).toBe(`${SANDBOX_API}/v2/checkout/orders`);
    expect(order.headers.Authorization).toBe("Bearer tok");
    expect(order.headers["PayPal-Request-Id"]).toBe("order-mdt_1");
    expect(order.body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [{ custom_id: "mdt_1", amount: { currency_code: "USD", value: "60.00" } }],
    });
  });

  it("reads the authorization out of the authorize response", async () => {
    const { fn } = fakeFetch(() => ({
      json: {
        purchase_units: [
          { custom_id: "mdt_1", payments: { authorizations: [{ id: "AUTH1", status: "CREATED", amount: { value: "60.00" }, expiration_time: "2026-12-10T00:00:00Z" }] } },
        ],
      },
    }));
    const r = await createSandboxPayPal({ fetchFn: fn }).authorizeOrder("ORDER1");
    expect(r).toEqual({ authorizationId: "AUTH1", status: "CREATED", amountCents: 6000, expiresAt: "2026-12-10T00:00:00Z", customId: "mdt_1" });
  });

  it("captures the final total with final_capture: true and an idempotency key", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, json: { id: "CAP1", status: "COMPLETED", amount: { value: "51.84" } } }));
    const r = await createSandboxPayPal({ fetchFn: fn }).captureAuthorization({ authorizationId: "AUTH1", amountCents: 5184, invoiceId: "mdt_1", requestId: "capture-mdt_1" });
    expect(r).toEqual({ captureId: "CAP1", status: "COMPLETED", amountCents: 5184 });
    const c = calls[1];
    expect(c.url).toBe(`${SANDBOX_API}/v2/payments/authorizations/AUTH1/capture`);
    expect(c.headers["PayPal-Request-Id"]).toBe("capture-mdt_1");
    expect(c.body).toEqual({ amount: { currency_code: "USD", value: "51.84" }, final_capture: true, invoice_id: "mdt_1" });
  });

  it("voids, refunds, and pays out with the operator's own credentials", async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/void")) return { status: 204 };
      if (c.url.endsWith("/refund")) return { status: 201, json: { id: "REF1", status: "COMPLETED" } };
      return { status: 201, json: { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING" } } };
    });
    const pp = createSandboxPayPal({ fetchFn: fn });
    expect(await pp.voidAuthorization({ authorizationId: "AUTH1", requestId: "void-1" })).toEqual({ status: "VOIDED" });
    expect(await pp.refundCapture({ captureId: "CAP1", amountCents: 3995, note: "n", requestId: "refund-1" })).toEqual({ refundId: "REF1", status: "COMPLETED" });
    expect(await pp.operatorPayout({ receiverEmail: "m@x.test", amountCents: 3995, note: "bond", senderBatchId: "bond-1" })).toEqual({
      payoutBatchId: "PB1",
      status: "PENDING",
    });
    const tokenCalls = calls.filter((c) => c.url.endsWith("/oauth2/token"));
    expect(tokenCalls.map((c) => c.headers.Authorization)).toEqual([
      `Basic ${Buffer.from("merchant-id:merchant-secret").toString("base64")}`,
      `Basic ${Buffer.from("op-id:op-secret").toString("base64")}`,
    ]);
    const payout = calls.find((c) => c.url.endsWith("/v1/payments/payouts"))!;
    expect(payout.body).toMatchObject({ items: [{ recipient_type: "EMAIL", receiver: "m@x.test", amount: { currency: "USD", value: "39.95" } }] });
  });

  it("maps PayPal errors", async () => {
    const { fn } = fakeFetch(() => ({
      status: 422,
      json: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "dbg", details: [{ issue: "AUTHORIZATION_VOIDED", description: "voided" }] },
    }));
    const err = await createSandboxPayPal({ fetchFn: fn })
      .captureAuthorization({ authorizationId: "A", amountCents: 1, invoiceId: "i", requestId: "r" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ httpStatus: 422, name: "UNPROCESSABLE_ENTITY", debugId: "dbg" });
    expect(err.message).toContain("AUTHORIZATION_VOIDED");
  });

  it("verifies webhooks through PayPal and fails closed without a webhook id", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { verification_status: "SUCCESS" } }));
    const pp = createSandboxPayPal({ fetchFn: fn });
    const headers = new Headers({
      "paypal-transmission-id": "t1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "now",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-auth-algo": "SHA256withRSA",
    });
    const event = { id: "WH-1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "AUTH1" } };
    delete process.env.PAYPAL_WEBHOOK_ID;
    expect(await pp.verifyWebhook(headers, event)).toBe(false);
    process.env.PAYPAL_WEBHOOK_ID = "WHID";
    expect(await pp.verifyWebhook(headers, event)).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ webhook_id: "WHID", transmission_id: "t1", webhook_event: event });
    expect(await pp.verifyWebhook(new Headers(), event)).toBe(false);
  });

  it("refuses the live environment", () => {
    process.env.PAYPAL_MODE = "live";
    expect(() => paypalMode()).toThrow(/Sandbox/);
    expect(() => createSandboxPayPal({ base: "https://api-m.paypal.com" })).toThrow(/Live/);
  });

  it("selects sandbox when credentials exist, mock otherwise", () => {
    delete process.env.PAYPAL_MODE;
    expect(paypalMode()).toBe("sandbox");
    delete process.env.PAYPAL_CLIENT_ID;
    expect(paypalMode()).toBe("mock");
  });
});

describe("PayPal simulator state machine", () => {
  async function authorized(cents = 6000) {
    const pp = createMockPayPal();
    const { orderId } = await pp.createAuthorizeOrder({ mandateId: "m", amountCents: cents, description: "" });
    const auth = await pp.authorizeOrder(orderId);
    return { pp, auth };
  }

  it("captures less than authorized and closes the authorization", async () => {
    const { pp, auth } = await authorized();
    const cap = await pp.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 5184, invoiceId: "m", requestId: "c1" });
    expect(cap.amountCents).toBe(5184);
    expect((await pp.getAuthorization(auth.authorizationId)).status).toBe("CAPTURED");
    await expect(pp.voidAuthorization({ authorizationId: auth.authorizationId, requestId: "v1" })).rejects.toThrow(/CAPTURED/);
  });

  it("rejects over-capture and capture after void", async () => {
    const { pp, auth } = await authorized();
    await expect(pp.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 7439, invoiceId: "m", requestId: "c1" })).rejects.toThrow(
      /MAX_CAPTURE/,
    );
    await pp.voidAuthorization({ authorizationId: auth.authorizationId, requestId: "v1" });
    await expect(pp.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 100, invoiceId: "m", requestId: "c2" })).rejects.toThrow(
      /VOIDED/,
    );
  });

  it("is idempotent on request id and refuses over-refunds", async () => {
    const { pp, auth } = await authorized();
    const a = await pp.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 3995, invoiceId: "m", requestId: "same" });
    const b = await pp.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 3995, invoiceId: "m", requestId: "same" });
    expect(b.captureId).toBe(a.captureId);
    await pp.refundCapture({ captureId: a.captureId, amountCents: 3995, note: "", requestId: "r1" });
    await expect(pp.refundCapture({ captureId: a.captureId, amountCents: 1, note: "", requestId: "r2" })).rejects.toThrow(/REFUND_AMOUNT_EXCEEDED/);
  });
});
