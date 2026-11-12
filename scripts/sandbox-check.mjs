// Preflight for the real integrations (README section 10, "Verify before building further").
// Usage: npm run sandbox-check [-- --payout]
// Reads .env.local, talks only to the PayPal SANDBOX host and Gemini, and never prints a secret.
//   default   credentials for both apps, an AUTHORIZE order, webhook registration, the Gemini model
//   --payout  also sends a $0.01 sandbox payout from the operator app to the merchant (play money)

import fs from "node:fs";
import path from "node:path";

const BASE = "https://api-m.sandbox.paypal.com";
const file = path.join(process.cwd(), ".env.local");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const env = (k) => process.env[k] || "";
const withPayout = process.argv.includes("--payout");
let failures = 0;
let warnings = 0;

function report(level, label, extra = "") {
  const tag = { ok: "  ok  ", warn: "  WARN", fail: "  FAIL", todo: "  TODO" }[level];
  console.log(`${tag} ${label}${extra ? `  (${extra})` : ""}`);
  if (level === "fail") failures++;
  if (level === "warn" || level === "todo") warnings++;
}

async function token(idKey, secretKey) {
  if (!env(idKey) || !env(secretKey)) throw new Error(`${idKey} / ${secretKey} not set`);
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env(idKey)}:${env(secretKey)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(json.error_description || `HTTP ${res.status}`);
  return json;
}

async function paypal(tok, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json.details ?? []).map((d) => d.issue).join(", ");
    throw new Error(`${json.name ?? res.status}${detail ? `: ${detail}` : json.message ? `: ${json.message}` : ""}`);
  }
  return json;
}

console.log(`PayPal sandbox preflight (${BASE})\n`);

let merchant = null;
try {
  merchant = (await token("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET")).access_token;
  report("ok", "merchant app credentials");
} catch (e) {
  report("fail", "merchant app credentials", e.message);
}

if (env("NEXT_PUBLIC_PAYPAL_CLIENT_ID") === env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_ID")) report("ok", "NEXT_PUBLIC_PAYPAL_CLIENT_ID matches the merchant app");
else report("fail", "NEXT_PUBLIC_PAYPAL_CLIENT_ID must equal PAYPAL_CLIENT_ID (the JS SDK and the server must use the same app)");

if (merchant) {
  try {
    const order = await paypal(merchant, "POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [{ custom_id: "preflight", description: "Sentinel preflight (never approved)", amount: { currency_code: "USD", value: "1.00" } }],
    });
    report("ok", "create order with intent AUTHORIZE", `${order.id}, status ${order.status}`);
  } catch (e) {
    report("fail", "create order with intent AUTHORIZE", e.message);
  }

  try {
    const hooks = (await paypal(merchant, "GET", "/v1/notifications/webhooks")).webhooks ?? [];
    const wanted = ["PAYMENT.AUTHORIZATION.VOIDED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"];
    const mine = hooks.find((h) => h.id === env("PAYPAL_WEBHOOK_ID"));
    if (!env("PAYPAL_WEBHOOK_ID")) {
      report("todo", "PAYPAL_WEBHOOK_ID is empty: webhooks will be stored as unverified", `${hooks.length} webhook(s) registered on the app`);
      for (const h of hooks) console.log(`         ${h.id}  ${h.url}`);
    } else if (!mine) {
      report("fail", "PAYPAL_WEBHOOK_ID is not a webhook of the merchant app");
    } else {
      const names = mine.event_types.map((t) => t.name);
      const missing = names.includes("*") ? [] : wanted.filter((w) => !names.includes(w));
      if (missing.length) report("warn", `webhook ${mine.url} is missing events`, missing.join(", "));
      else report("ok", "webhook registered with the required events", mine.url);
    }
  } catch (e) {
    report("warn", "could not list webhooks", e.message);
  }
}

let operator = null;
try {
  operator = (await token("PAYPAL_OPERATOR_CLIENT_ID", "PAYPAL_OPERATOR_CLIENT_SECRET")).access_token;
  report("ok", "agent operator app credentials");
  if (env("PAYPAL_OPERATOR_CLIENT_ID") === env("PAYPAL_CLIENT_ID")) report("warn", "operator app is the same app as the merchant: the bond would be the merchant paying itself");
} catch (e) {
  report("fail", "agent operator app credentials", e.message);
}

if (!env("PAYPAL_MERCHANT_EMAIL")) report("fail", "PAYPAL_MERCHANT_EMAIL not set (bond payout has no recipient)");
else if (operator && withPayout) {
  try {
    const p = await paypal(operator, "POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: `preflight-${Date.now()}`, email_subject: "Sentinel preflight" },
      items: [{ recipient_type: "EMAIL", receiver: env("PAYPAL_MERCHANT_EMAIL"), amount: { currency: "USD", value: "0.01" }, note: "Sentinel preflight" }],
    });
    report("ok", "Payouts enabled on the operator app", `batch ${p.batch_header.payout_batch_id}, ${p.batch_header.batch_status}`);
  } catch (e) {
    report("fail", "Payouts on the operator app", e.message);
  }
} else if (operator) report("todo", "Payouts not exercised: rerun with --payout to send a $0.01 sandbox payout");

console.log("\nGemini\n");
const model = env("GEMINI_MODEL") || "gemini-3.5-flash-lite";
if (!env("GOOGLE_GENERATIVE_AI_API_KEY")) report("todo", "GOOGLE_GENERATIVE_AI_API_KEY not set: rule-based parser and cached traces will be used");
else {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env("GOOGLE_GENERATIVE_AI_API_KEY") },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with the single word: ready" }] }] }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.status ? `${json.error.status}: ${String(json.error.message).slice(0, 120)}` : `HTTP ${res.status}`);
    report("ok", `model ${model} answers on this key`);
  } catch (e) {
    report("fail", `model ${model}`, e.message);
  }
}

console.log(
  failures
    ? `\n${failures} check(s) FAILED`
    : `\nAll automatic checks passed${warnings ? ` (${warnings} item(s) need attention)` : ""}. Still manual: approve a hold as the sandbox buyer in the browser.`,
);
process.exit(failures ? 1 : 0);
