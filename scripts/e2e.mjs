// End-to-end check against a running server (default http://localhost:3000).
// Usage: npm run e2e  [-- http://host:port]
// Drives all three demo scenarios plus the merchant-fault and user-fault paths
// through the real HTTP API, exactly as the UI does.

const BASE = process.argv[2] || process.env.SENTINEL_URL || "http://localhost:3000";
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function check(label, ok, extra = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}

async function authorized(intent, scenario) {
  const created = await call("POST", "/api/mandates", { intent, scenario });
  if (created.status !== 200) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
  const id = created.json.mandate.id;
  const order = await call("POST", `/api/mandates/${id}/order`, {});
  const auth = await call("POST", `/api/mandates/${id}/authorize`, { orderId: order.json.orderId });
  if (auth.status !== 200) throw new Error(`authorize failed: ${JSON.stringify(auth.json)}`);
  return id;
}

const SAFE = "Buy me a webcam under $60, USB-C, arriving this week, no subscriptions.";
const BLOCKED = "Get me a USB-C microphone for my podcast under $60, arriving this week, no subscriptions.";
const SLIPPED = "Buy me a webcam under $60 that works with my MacBook, USB-C, arriving this week, no subscriptions.";

const health = await call("GET", "/api/health");
console.log(`server ${BASE}: paypal=${health.json.paypal} llm=${health.json.llm}`);
check("health", health.status === 200 && health.json.ok);

console.log("\nScenario 1: safe purchase");
{
  const id = await authorized(SAFE, "safe");
  const run = await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  check("captured", run.json.outcome === "CAPTURED", JSON.stringify(run.json));
  const v = (await call("GET", `/api/mandates/${id}`)).json;
  check("captured $51.84", v.decision?.capturedAmountCents === 5184);
  check("all 7 rules pass", v.decision?.results.length === 7 && v.decision.results.every((r) => r.pass));
  check("hash chain intact", v.chain.ok);
  const rerun = await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  check("second run refused (409)", rerun.status === 409);
}

console.log("\nScenario 2: blocked purchase");
{
  const id = await authorized(BLOCKED, "blocked");
  const run = await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  check("voided", run.json.outcome === "VOIDED");
  check("R1, R3, R6 failed", ["R1", "R3", "R6"].every((r) => run.json.failedRules.includes(r)), run.json.failedRules.join(","));
  const v = (await call("GET", `/api/mandates/${id}`)).json;
  check("total $74.39", v.decision?.totalCents === 7439);
  check("injection flagged in trace", v.trace.some((e) => e.type === "injection_scan" && e.payload.flagged));
  const c = await call("POST", `/api/mandates/${id}/complaint`, { text: "where is my mic" });
  check("cannot dispute a voided purchase (409)", c.status === 409);
}

console.log("\nScenario 3: slipped through, then settled");
{
  const id = await authorized(SLIPPED, "slipped");
  const run = await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  check("captured", run.json.outcome === "CAPTURED");
  const c = await call("POST", `/api/mandates/${id}/complaint`, { text: "This isn't what I asked for. It doesn't work with my MacBook." });
  check("agent fault", c.json.verdict?.fault === "AGENT", JSON.stringify(c.json.verdict?.fault ?? c.json));
  check("refund + bond payout", Boolean(c.json.verdict?.refundId && c.json.verdict?.payoutId));
  check("quotes 'Windows only' listing line", c.json.verdict?.evidence.some((e) => e.text.includes("Windows only")));
  await new Promise((r) => setTimeout(r, 800));
  const v = (await call("GET", `/api/mandates/${id}`)).json;
  check("status SETTLED_AGENT", v.mandate.status === "SETTLED_AGENT");
  check("webhooks recorded", v.webhooks.length >= 4, v.webhooks.map((w) => w.eventType).join(","));
  check("hash chain intact", v.chain.ok);
}

console.log("\nMerchant fault: listing edited after purchase");
{
  const id = await authorized(SAFE, "safe");
  await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  const edit = await call("POST", `/api/mandates/${id}/merchant-edit`, {});
  check("merchant edit applied", edit.status === 200);
  const c = await call("POST", `/api/mandates/${id}/complaint`, { text: "It came with a USB-A cable, not USB-C." });
  check("merchant fault, refund only", c.json.verdict?.fault === "MERCHANT" && c.json.verdict.refundId && !c.json.verdict.payoutId);
  await call("POST", "/api/demo/reset-listings", {});
}

console.log("\nUser responsibility: ambiguous instruction");
{
  const id = await authorized(SAFE.replace("USB-C", "usb-c"), null);
  const run = await call("POST", `/api/mandates/${id}/run`, { agentMode: "cached" });
  check("rule-based shopper captured", run.json.outcome === "CAPTURED" && run.json.agentMode === "heuristic", JSON.stringify(run.json));
  const c = await call("POST", `/api/mandates/${id}/complaint`, { text: "It doesn't work with my Mac." });
  check("user responsibility, no refund", c.json.verdict?.fault === "USER" && !c.json.verdict.refundId, JSON.stringify(c.json.verdict?.fault));
}

console.log("\nInput validation and webhooks");
{
  const bad = await call("POST", "/api/mandates", { intent: "buy me something nice" });
  check("unparseable intent -> 422", bad.status === 422, bad.json.error);
  const missing = await call("GET", "/api/mandates/mdt_nope");
  check("unknown mandate -> 404", missing.status === 404);
  const forged = await call("POST", "/api/webhooks/paypal", { id: "WH-FORGED-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X" } });
  check("forged webhook accepted but not verified", forged.status === 200 && forged.json.verified === false);
  const ledger = await call("GET", "/api/ledger");
  check("ledger lists mandates", ledger.json.rows.length >= 5);
  for (const page of ["/", "/ledger"]) {
    const res = await fetch(BASE + page);
    check(`page ${page} renders`, res.status === 200);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
