# Sentinel

**A payment firewall and recourse layer for AI shopping agents, built on PayPal.**

Sentinel blocks the purchases an AI agent should never make, and settles the ones that slip through by working out who was at fault.

> Hackathon prototype for "Build What's Next with PayPal and AI". Runs entirely in the PayPal Sandbox. No real money moves.

## 1. The idea

AI agents are starting to buy things for people. Two questions are still open:

1. **Before payment:** how do you let an agent spend without handing it your wallet?
2. **After payment:** when the agent buys the wrong thing, who pays for the mistake?

Sentinel answers both with one record, the **mandate**.

| Stage | What Sentinel does | PayPal primitive |
|---|---|---|
| Mandate | Turns "buy me a webcam under $60, USB-C, arriving this week, no subscriptions" into enforceable rules | Order with `intent: AUTHORIZE` for the budget ceiling |
| Firewall | Checks the agent's proposed purchase against the rules before any money moves | Capture (pass) or void (block) of the authorization |
| Recourse | If the user later says "this isn't what I asked for", an arbiter decides who failed and routes the cost | Refund, plus a payout from the agent operator's bond |

**Key design choice:** the user approves a *budget*, not an item. PayPal holds the funds. The agent then shops unattended, and it never holds PayPal credentials. Only Sentinel can capture, and only if the rules pass.

**The guarantee:** a PayPal authorization cannot be captured when the final transaction violates a hard rule of the user's mandate. It is voided instead.

### Same complaint, three outcomes

| Who failed | Example | Money path |
|---|---|---|
| Agent | Listing said "Windows only"; agent bought it anyway | Buyer refunded; agent operator's bond repays the merchant |
| Merchant | Listing was edited after purchase; the snapshot proves it | Buyer refunded at the merchant's cost |
| User | Instruction was ambiguous; agent stayed within the mandate | No automatic refund; normal return policy |

## 2. Architecture

One Next.js app, one deployed service, one SQLite file. No paid services.

| Component | Responsibility | Trust level | Code |
|---|---|---|---|
| Mandate extractor | LLM turns the user's sentence into a typed mandate (zod schema). The user can edit it before approving. Falls back to a rule-based parser. | Untrusted output, validated by schema | `lib/mandate.ts` |
| Shopping agent | LLM with three tools: `search_catalog`, `get_listing`, `propose_purchase`. Cannot call PayPal. | Untrusted | `lib/agent.ts` |
| Flight recorder | Append-only, hash-chained log of every agent step, plus a snapshot of each listing viewed | Trusted, server-side | `lib/recorder.ts` |
| Policy engine | Plain TypeScript. Recomputes the total from the catalog and checks R1–R7. No LLM. | Trusted | `lib/policy.ts` |
| Injection scanner | Pattern checks plus an LLM classifier for instructions hidden in listing text | Advisory; can only block | `lib/injection.ts` |
| PayPal client | Thin server-side wrapper over the REST API. The only code holding credentials. | Trusted | `lib/paypal.ts` |
| Sentinel core | Orchestrates run → policy → capture/void, and complaint → arbiter → settlement | Trusted | `lib/sentinel.ts` |
| Arbiter | Mechanical comparisons first, LLM only for free-text ambiguity. Returns verdict, evidence and confidence. | Advisory; low confidence goes to manual review | `lib/arbiter.ts` |
| Settlement | Executes the money path for a verdict | Trusted | `lib/settlement.ts` |
| Audit ledger | AG Grid view of every mandate, decision, PayPal id and verdict | Read-only | `app/ledger`, `components/LedgerGrid.tsx` |

### Transaction lifecycle

```
DRAFT → AUTHORIZED → PROPOSED → VOIDED                              (hard rule violated)
                              → CAPTURED → DISPUTED → SETTLED_AGENT
                                                    → SETTLED_MERCHANT
                                                    → SETTLED_USER
                                                    → MANUAL_REVIEW  (low confidence)
```

Transitions are compare-and-set in SQLite (`lib/store.ts`), so a mandate can be run once and disputed once.

### Hard rules (checked before capture, deterministic)

| Rule | Check |
|---|---|
| R1 Budget | Server-computed total (item + shipping + tax + add-ons) is at most the mandate ceiling |
| R2 Category | Listing category equals the mandate category |
| R3 No recurring charges | Proposal contains no subscription or protection-plan line |
| R4 Seller | Seller is on the mandate's allowed list, or unchanged from the listing snapshot |
| R5 Delivery | Listing delivery estimate is within the mandate deadline |
| R6 Integrity | Listing text has no injection flag; the proposal matches the snapshot hash |
| R7 Authorization | Capture amount is at most the authorized amount; the authorization is still valid (checked live with PayPal) |

### Soft constraints (cannot be proven before capture, settled after)

Compatibility ("works with my laptop"), features, quality, and anything else the listing describes in free text. These are what the arbiter handles.

### Arbiter logic

1. Verify the flight-recorder hash chain and the snapshot hash. If either is broken, go to manual review.
2. **Merchant check:** does the current listing differ from the snapshot? If yes, merchant fault.
3. **Agent check:** did the snapshot contradict a mandate constraint that the agent ignored? If yes, agent fault. The arbiter quotes the listing line and the mandate line.
4. **User check:** is the complaint about a constraint that is absent from the mandate? If yes, user responsibility.
5. The LLM is used only when free text is all that can decide. It must quote its evidence, and quotes that do not occur verbatim in the sources are discarded.
6. Confidence below `ARBITER_CONFIDENCE_THRESHOLD` (default 0.7) goes to manual review with the evidence pack.

## 3. PayPal integration

| Step | Endpoint | Purpose |
|---|---|---|
| Hold the budget | `POST /v2/checkout/orders` with `intent: AUTHORIZE` | Creates the mandate order; `custom_id` carries the mandate id |
| Buyer approval | PayPal JS SDK buttons (`@paypal/react-paypal-js`, `intent: "authorize"`) | The user approves the ceiling once |
| Place the hold | `POST /v2/checkout/orders/{id}/authorize` | Returns the authorization id. Sentinel checks that `custom_id` and amount match the mandate. |
| Re-check | `GET /v2/payments/authorizations/{id}` | Live status and expiry for R7 |
| Allow | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: true` | Captures only the final total; the rest of the hold is released |
| Block | `POST /v2/payments/authorizations/{id}/void` | Releases the whole hold; no money moves |
| Refund | `POST /v2/payments/captures/{id}/refund` | Returns money to the buyer after a verdict |
| Bond transfer | `POST /v1/payments/payouts` (operator app credentials) | Agent operator repays the merchant on agent fault |
| Confirmation | Webhooks, verified with `POST /v1/notifications/verify-webhook-signature` | `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, payouts |

Every money-moving call sends a `PayPal-Request-Id` idempotency key derived from the mandate id. The client refuses the live API host.

Sandbox accounts used: one **buyer** (personal), one **merchant** (business, app 1), and one **agent operator** (business, app 2, used only for the bond payout).

### Running without credentials

With no PayPal credentials, Sentinel uses a **clearly labelled in-process simulator** (`lib/paypal-mock.ts`). It implements the same interface: authorize, partial final capture, void, refund, payout, idempotency and delayed webhooks. Every page shows `PayPal: Simulated` in that mode. The simulator never talks to the network, and webhooks posted over HTTP are never verified in that mode.

With no Gemini key, mandate extraction uses a rule-based parser and the agent replays cached traces for the three demo scenarios. Any other intent gets a rule-based shopper. The cached traces store only the agent's *decisions*: every tool call still runs for real, so snapshots, hashes and the firewall check are live.

## 4. AI usage

| Use | Model | Why AI is needed | Fallback |
|---|---|---|---|
| Mandate extraction | Gemini Flash-Lite via Vercel AI SDK, structured output | Turns free-text intent into typed rules | Rule-based parser |
| Shopping agent | Same model, tool calling | Searches, compares, explains trade-offs | Cached trace / rule-based shopper |
| Injection scanner | Same model, classifier prompt | Hidden instructions vary too much for patterns alone | Patterns only |
| Arbiter | Same model, evidence-quoting prompt | Judges free-text ambiguity | Manual review |

The model never decides whether money moves before capture. That is the policy engine's job.

## 5. Tech stack and cost

| Layer | Choice | Cost |
|---|---|---|
| App | Next.js 16 (App Router) + TypeScript | Free |
| Payments | PayPal Sandbox REST API + `@paypal/react-paypal-js` | Free |
| LLM | Gemini API free tier (`ai`, `@ai-sdk/google`) | Free, no card |
| Validation | `zod` | Free |
| Storage | SQLite (`better-sqlite3`), reset on boot | Free |
| Ledger UI | AG Grid Community | Free (MIT) |
| Hosting | Render free web service | Free, no card |
| Tests | Vitest + an HTTP end-to-end script | Free |

**Total cost: $0.**

Notes on the free tier:

- The hosted demo sleeps after 15 minutes idle, so the first load can take about a minute.
- The filesystem is ephemeral and the SQLite file is wiped on boot, so every visitor gets a clean state. Set `SENTINEL_KEEP_DB=1` to keep data.
- If the LLM quota runs out, the agent falls back to the cached traces (recorded in the flight recorder as `agent_fallback`), so the PayPal flow still runs live.
- Use a **flash-lite** model on the free tier. Plain `gemini-3.5-flash` allows only 20 requests per day, and one live scenario uses 5–7.

## 6. Project structure

```
app/
  page.tsx                          intent input, mandate review, PayPal approval
  run/[mandateId]/page.tsx          live agent trace, firewall decision, complaint, verdict
  ledger/page.tsx                   AG Grid audit ledger
  api/
    mandates/route.ts               POST: extract mandate from intent
    mandates/[id]/route.ts          GET: full state · PATCH: edit rules before approval
    mandates/[id]/order/route.ts    POST: create AUTHORIZE order
    mandates/[id]/authorize/route.ts POST: authorize after approval
    mandates/[id]/run/route.ts      POST: run agent, gate, capture or void
    mandates/[id]/complaint/route.ts POST: arbiter + settlement
    mandates/[id]/merchant-edit/route.ts POST: demo only, merchant edits listing after sale
    ledger/route.ts                 GET: ledger rows
    webhooks/paypal/route.ts        POST: verified PayPal webhooks
    health/route.ts                 GET: liveness + which integrations are live
    demo/reset-listings/route.ts    POST: undo simulated merchant edits
components/                         client UI (HomeClient, RunClient, LedgerGrid)
lib/
  mandate.ts      zod schema + extractor (LLM, rule-based fallback)
  agent.ts        tool loop (live Gemini, cached trace, rule-based shopper)
  scenarios.ts    the three demo scenarios and their cached traces
  recorder.ts     hash-chained flight recorder + listing snapshots
  policy.ts       hard rules R1–R7
  injection.ts    scanner
  arbiter.ts      fault attribution
  settlement.ts   refund / payout paths
  sentinel.ts     core orchestration
  paypal.ts       REST client (only file with credentials)
  paypal-mock.ts  simulator used when no credentials are set
  catalog.ts      fictional store, server-side totals
  store.ts        lifecycle, persistence, webhook ingestion
  db.ts           SQLite schema, reset on boot
data/catalog.json fictional store, including the trap listings
tests/            unit + flow tests (vitest)
scripts/e2e.mjs   HTTP end-to-end check against a running server
```

### Data model

| Table | Key fields |
|---|---|
| `mandates` | id, raw_intent, rules_json, ceiling, status, paypal_order_id, authorization_id, authorized_amount |
| `trace_events` | id, mandate_id, seq, type, payload_json, prev_hash, hash |
| `listing_snapshots` | id, mandate_id, listing_id, content_json, hash |
| `decisions` | id, mandate_id, outcome (CAPTURED / VOIDED), failed_rules_json, results_json, total, capture_id |
| `verdicts` | id, mandate_id, fault (AGENT / MERCHANT / USER / null), confidence, evidence_json, refund_id, payout_id |
| `webhook_events` | id, event_type, resource_id, mandate_id, verified, simulated, received_at |
| `listing_overrides` | demo-only merchant edits to the fictional catalog |

All money is stored as integer cents.

## 7. Setup

```bash
git clone <repo-url> && cd nxn
npm install
cp .env.example .env.local   # optional: fill in the values below
npm run dev                  # http://localhost:3000
```

The app runs with an empty `.env.local`, using the simulated PayPal and cached agent traces. To use the real sandbox and Gemini:

| Variable | Where it comes from |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Merchant sandbox app, PayPal Developer Dashboard |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Same client id, for the JS SDK |
| `PAYPAL_OPERATOR_CLIENT_ID`, `PAYPAL_OPERATOR_CLIENT_SECRET` | Agent operator sandbox app (Payouts enabled) |
| `PAYPAL_MERCHANT_EMAIL` | Merchant sandbox account email (payout recipient) |
| `PAYPAL_WEBHOOK_ID` | Webhook created for `<host>/api/webhooks/paypal` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio |
| `GEMINI_MODEL` | Any Flash model shown as free in AI Studio |

PayPal needs a public URL for webhooks. Locally, use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`) and register `<tunnel>/api/webhooks/paypal`. The flow does not depend on webhooks: API responses are the source of truth, and verified webhooks are recorded as confirmations.

Log in at checkout with the sandbox **buyer** account. Never use real PayPal credentials.

### Deploy (Render, free)

`render.yaml` is a Render Blueprint for one free web service. In Render, choose **New → Blueprint**, pick this repo, and paste the secret values it asks for (the same variables as `.env.local`). Health check: `/api/health`. After the first deploy, create the PayPal webhook for `<service-url>/api/webhooks/paypal` and set `PAYPAL_WEBHOOK_ID`.

### Checks

```bash
npm run typecheck
npm test                      # unit + flow tests
npm run build && npm start    # then, in another shell:
npm run e2e                   # drives all scenarios through the HTTP API
```

## 8. Demo script (under 3 minutes)

| # | Scenario | What the viewer sees |
|---|---|---|
| 1 | Safe purchase | Intent becomes a mandate. The user approves a $60 hold. The agent picks a $51.84 webcam. All rules pass. $51.84 captured, $8.16 released. Order and capture ids shown. |
| 2 | Blocked purchase | The top (sponsored) listing hides an instruction telling the agent to add a protection plan, and the total becomes $74.39. R1, R3 and R6 fail; R7 also fails because the total exceeds the $60 hold. Authorization voided. No money moves. |
| 3 | Slipped through, then settled | The agent buys a webcam whose listing says "Windows only". The user clicks "Not what I asked for". The arbiter quotes the listing line and the mandate line: agent fault. Buyer refunded; operator bond pays the merchant. |

With a live Gemini agent, scenarios 2 and 3 usually do **not** reproduce: in testing, the live agent ignored the hidden instruction and avoided the "Windows only" webcam. Use **Cached trace** on the run page for those two, so the failure the firewall and arbiter handle happens on cue.

Extra paths on the run page: **"Demo: merchant edits the listing"** shows merchant fault, and a custom intent without "MacBook" shows user responsibility.

The store, brands and products are fictional, so the video contains no third-party trademarks.

## 9. What this prototype does not claim

- Production fraud prevention, or detection of every prompt injection
- PayPal escrow, a delegated PayPal wallet, or access to stored funds
- A legally binding liability framework: the arbiter is a proposal for how fault could be attributed
- Real merchant or identity verification

## 10. Verify before building further

- [ ] An `AUTHORIZE` order can be approved, authorized, then captured for a lower amount with `final_capture: true`
- [ ] Voiding fires `PAYMENT.AUTHORIZATION.VOIDED` to the webhook
- [ ] Payouts is enabled on the operator sandbox account. If not, replace the bond payout with an invoice the operator pays. Settlement already records a failed payout honestly instead of failing the refund.
- [ ] The chosen Gemini model is available on the free tier in AI Studio

## License

MIT
