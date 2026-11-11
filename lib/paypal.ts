import { centsToValue, valueToCents } from "./util";
import { createMockPayPal } from "./paypal-mock";

/**
 * PayPal client. Thin server-side wrapper over the REST API and the ONLY code
 * that reads PayPal credentials. Sandbox only: the live API host is never used.
 *
 * Without credentials the app uses a clearly labelled simulator (paypal-mock.ts)
 * that implements the same interface so the flow can be exercised locally.
 */

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export type PayPalMode = "sandbox" | "mock";

export interface AuthorizeResult {
  authorizationId: string;
  status: string;
  amountCents: number;
  expiresAt: string | null;
  customId: string | null;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource?: { id?: string; custom_id?: string; status?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface PayPalGateway {
  mode: PayPalMode;
  createAuthorizeOrder(args: { mandateId: string; amountCents: number; description: string }): Promise<{ orderId: string }>;
  authorizeOrder(orderId: string): Promise<AuthorizeResult>;
  getAuthorization(authorizationId: string): Promise<{ status: string; amountCents: number; expiresAt: string | null }>;
  captureAuthorization(args: {
    authorizationId: string;
    amountCents: number;
    invoiceId: string;
    requestId: string;
  }): Promise<{ captureId: string; status: string; amountCents: number }>;
  voidAuthorization(args: { authorizationId: string; requestId: string }): Promise<{ status: string }>;
  refundCapture(args: { captureId: string; amountCents: number; note: string; requestId: string }): Promise<{ refundId: string; status: string }>;
  operatorPayout(args: {
    receiverEmail: string;
    amountCents: number;
    note: string;
    senderBatchId: string;
  }): Promise<{ payoutBatchId: string; status: string }>;
  verifyWebhook(headers: Headers, event: WebhookEvent): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    public httpStatus: number,
    public name: string,
    message: string,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function paypalMode(): PayPalMode {
  const forced = process.env.PAYPAL_MODE?.trim().toLowerCase();
  if (forced === "live" || forced === "production") throw new Error("Sentinel only runs against the PayPal Sandbox. PAYPAL_MODE=live is refused.");
  if (forced === "mock") return "mock";
  if (forced === "sandbox") return "sandbox";
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "sandbox" : "mock";
}

const globalForPayPal = globalThis as unknown as { __sentinelPayPal?: PayPalGateway };

export function getPayPal(): PayPalGateway {
  if (globalForPayPal.__sentinelPayPal) return globalForPayPal.__sentinelPayPal;
  const mode = paypalMode();
  globalForPayPal.__sentinelPayPal = mode === "sandbox" ? createSandboxPayPal() : createMockPayPal();
  return globalForPayPal.__sentinelPayPal;
}

/** Test helper. */
export function setPayPalForTests(gw: PayPalGateway | undefined) {
  globalForPayPal.__sentinelPayPal = gw;
}

// ---------------------------------------------------------------------------
// Sandbox REST implementation
// ---------------------------------------------------------------------------

interface Credentials {
  clientId: string;
  clientSecret: string;
}

type FetchFn = typeof fetch;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. See .env.example.`);
  return v;
}

class TokenCache {
  private token: string | null = null;
  private expiresAt = 0;
  constructor(
    private creds: () => Credentials,
    private fetchFn: FetchFn,
    private base: string,
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const { clientId, clientSecret } = this.creds();
    const res = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token)
      throw new PayPalError(res.status, "AUTHENTICATION_FAILURE", body.error_description ?? "Could not get a PayPal access token");
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3000) * 1000;
    return this.token;
  }
}

export function createSandboxPayPal(opts: { fetchFn?: FetchFn; base?: string } = {}): PayPalGateway {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.base ?? SANDBOX_API;
  if (base.includes("api-m.paypal.com") || base.includes("api.paypal.com")) throw new Error("Live PayPal host refused");

  const merchant = new TokenCache(
    () => ({ clientId: requireEnv("PAYPAL_CLIENT_ID"), clientSecret: requireEnv("PAYPAL_CLIENT_SECRET") }),
    fetchFn,
    base,
  );
  const operator = new TokenCache(
    () => ({ clientId: requireEnv("PAYPAL_OPERATOR_CLIENT_ID"), clientSecret: requireEnv("PAYPAL_OPERATOR_CLIENT_SECRET") }),
    fetchFn,
    base,
  );

  async function call<T>(
    tokens: TokenCache,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await tokens.get()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details = json.details as { issue?: string; description?: string }[] | undefined;
      const message = [json.message, details?.map((d) => `${d.issue}: ${d.description}`).join("; ")].filter(Boolean).join(" ");
      throw new PayPalError(res.status, String(json.name ?? "PAYPAL_ERROR"), message || `HTTP ${res.status}`, json.debug_id as string, details);
    }
    return json as T;
  }

  const money = (cents: number) => ({ currency_code: "USD", value: centsToValue(cents) });

  return {
    mode: "sandbox",

    async createAuthorizeOrder({ mandateId, amountCents, description }) {
      const order = await call<{ id: string }>(
        merchant,
        "POST",
        "/v2/checkout/orders",
        {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              reference_id: mandateId,
              custom_id: mandateId,
              description: description.slice(0, 127),
              amount: money(amountCents),
            },
          ],
        },
        `order-${mandateId}`,
      );
      return { orderId: order.id };
    },

    async authorizeOrder(orderId) {
      type Auth = { id: string; status: string; amount: { value: string }; expiration_time?: string; custom_id?: string };
      const order = await call<{ purchase_units: { custom_id?: string; payments?: { authorizations?: Auth[] } }[] }>(
        merchant,
        "POST",
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
        {},
        `authorize-${orderId}`,
      );
      const unit = order.purchase_units?.[0];
      const auth = unit?.payments?.authorizations?.[0];
      if (!auth) throw new PayPalError(502, "NO_AUTHORIZATION", "PayPal returned no authorization for the order");
      return {
        authorizationId: auth.id,
        status: auth.status,
        amountCents: valueToCents(auth.amount.value),
        expiresAt: auth.expiration_time ?? null,
        customId: auth.custom_id ?? unit?.custom_id ?? null,
      };
    },

    async getAuthorization(authorizationId) {
      const a = await call<{ status: string; amount: { value: string }; expiration_time?: string }>(
        merchant,
        "GET",
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
      );
      return { status: a.status, amountCents: valueToCents(a.amount.value), expiresAt: a.expiration_time ?? null };
    },

    async captureAuthorization({ authorizationId, amountCents, invoiceId, requestId }) {
      const c = await call<{ id: string; status: string; amount?: { value: string } }>(
        merchant,
        "POST",
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
        { amount: money(amountCents), final_capture: true, invoice_id: invoiceId },
        requestId,
      );
      return { captureId: c.id, status: c.status, amountCents: c.amount ? valueToCents(c.amount.value) : amountCents };
    },

    async voidAuthorization({ authorizationId, requestId }) {
      const v = await call<{ status?: string }>(
        merchant,
        "POST",
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
        undefined,
        requestId,
      );
      return { status: v.status ?? "VOIDED" };
    },

    async refundCapture({ captureId, amountCents, note, requestId }) {
      const r = await call<{ id: string; status: string }>(
        merchant,
        "POST",
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        { amount: money(amountCents), note_to_payer: note.slice(0, 255) },
        requestId,
      );
      return { refundId: r.id, status: r.status };
    },

    async operatorPayout({ receiverEmail, amountCents, note, senderBatchId }) {
      const p = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>(operator, "POST", "/v1/payments/payouts", {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: "Sentinel: agent operator bond payment",
          email_message: note.slice(0, 255),
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: receiverEmail,
            amount: { currency: "USD", value: centsToValue(amountCents) },
            note: note.slice(0, 4000),
            sender_item_id: senderBatchId,
          },
        ],
      });
      return { payoutBatchId: p.batch_header.payout_batch_id, status: p.batch_header.batch_status };
    },

    async verifyWebhook(headers, event) {
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) return false;
      const h = (n: string) => headers.get(n) ?? "";
      if (!h("paypal-transmission-id") || !h("paypal-transmission-sig")) return false;
      const r = await call<{ verification_status: string }>(merchant, "POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      });
      return r.verification_status === "SUCCESS";
    },
  };
}
