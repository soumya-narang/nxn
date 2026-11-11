"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MandateView } from "@/lib/view";
import type { TraceEvent } from "@/lib/recorder";
import type { RuleResult } from "@/lib/policy";
import { api, usd } from "./api";

interface Props {
  initial: MandateView;
  llm: boolean;
  paypalMode: "sandbox" | "mock";
}

const FINAL = ["VOIDED", "SETTLED_AGENT", "SETTLED_MERCHANT", "SETTLED_USER", "MANUAL_REVIEW"];

export function RunClient({ initial, llm, paypalMode }: Props) {
  const [view, setView] = useState<MandateView>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<"live" | "cached">(llm ? "live" : "cached");
  const [complaint, setComplaint] = useState(initial.scenario?.complaint ?? "This isn't what I asked for.");
  const seen = useRef(new Set(initial.trace.map((e) => e.seq)));

  const m = view.mandate;
  const refresh = useCallback(async () => {
    const v = await api<MandateView>(`/api/mandates/${m.id}`);
    setView(v);
    return v;
  }, [m.id]);

  // Poll while something is in flight, and briefly after, so webhooks show up.
  useEffect(() => {
    if (!busy && FINAL.includes(m.status) && view.webhooks.length > 0) return;
    const t = setInterval(() => refresh().catch(() => {}), busy ? 500 : 2500);
    return () => clearInterval(t);
  }, [busy, m.status, view.webhooks.length, refresh]);

  useEffect(() => {
    const ids = view.trace.map((e) => e.seq);
    const timer = setTimeout(() => ids.forEach((s) => seen.current.add(s)), 600);
    return () => clearTimeout(timer);
  }, [view.trace]);

  async function act(label: string, path: string, body: unknown) {
    setBusy(label);
    setError(null);
    try {
      await api(path, { body });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh().catch(() => {});
      setBusy(null);
    }
  }

  const d = view.decision;
  const v = view.verdict;
  const policyEvent = [...view.trace].reverse().find((e) => e.type === "policy_decision");
  const lines = (policyEvent?.payload as { lines?: { label: string; amount: string }[] } | undefined)?.lines ?? [];

  return (
    <>
      <div className="row">
        <h1 style={{ margin: 0 }}>Mandate</h1>
        <StatusPill status={m.status} />
        {view.scenario && <span className="pill info">{view.scenario.title}</span>}
        <span className="spacer" />
        <span className="mono muted small">{m.id}</span>
      </div>
      <p className="lead" style={{ marginTop: 6 }}>
        <q>{m.rawIntent}</q>
      </p>
      <Stepper status={m.status} />
      {view.scenario && <p className="muted small">Expected: {view.scenario.expected}</p>}
      {error && <p className="error">{error}</p>}

      <div className="grid2" style={{ marginTop: 16 }}>
        <section className="card">
          <h2>Rules</h2>
          <dl className="ids">
            <dt>Category</dt>
            <dd>{m.rules.category}</dd>
            <dt>Ceiling</dt>
            <dd>{usd(m.rules.ceilingCents)} all-in</dd>
            <dt>Delivery</dt>
            <dd>{m.rules.maxDeliveryDays ? `≤ ${m.rules.maxDeliveryDays} days` : "no deadline"}</dd>
            <dt>Sellers</dt>
            <dd>{m.rules.allowedSellers.join(", ") || "any (must not change)"}</dd>
            <dt>Features</dt>
            <dd>{m.rules.requiredFeatures.join(", ") || "none"}</dd>
            <dt>Works with</dt>
            <dd>{m.rules.compatibility.join(", ") || "not specified"}</dd>
            {m.rules.notes.length > 0 && (
              <>
                <dt>Notes</dt>
                <dd>{m.rules.notes.join("; ")}</dd>
              </>
            )}
          </dl>
        </section>
        <section className="card">
          <h2>
            PayPal <span className={`pill ${paypalMode === "sandbox" ? "pass" : "warn"}`}>{paypalMode === "sandbox" ? "Sandbox" : "Simulated"}</span>
          </h2>
          <dl className="ids">
            <dt>Order (AUTHORIZE)</dt>
            <dd>{m.paypalOrderId ?? "—"}</dd>
            <dt>Authorization</dt>
            <dd>{m.authorizationId ? `${m.authorizationId} · ${usd(m.authorizedAmountCents ?? 0)} hold` : "—"}</dd>
            <dt>Capture</dt>
            <dd>{d?.captureId ? `${d.captureId} · ${usd(d.capturedAmountCents ?? 0)}` : "—"}</dd>
            <dt>Refund</dt>
            <dd>{v?.refundId ?? "—"}</dd>
            <dt>Bond payout</dt>
            <dd>{v?.payoutId ?? "—"}</dd>
          </dl>
          {view.webhooks.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3>Webhooks</h3>
              <div className="row">
                {view.webhooks.map((w) => (
                  <span key={w.id} className={`pill ${w.verified ? "pass" : "fail"}`} title={w.id}>
                    {w.eventType.replace("PAYMENT.", "")} {w.simulated ? "(sim)" : w.verified ? "✓" : "unverified"}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {m.status === "AUTHORIZED" && !m.runStartedAt && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Let the agent shop</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            The agent can search, read listings and propose one purchase. It cannot touch PayPal. Sentinel checks the proposal against R1–R7, then
            captures or voids.
          </p>
          <div className="row">
            <div className="checks">
              <label title={llm ? "" : "Set GOOGLE_GENERATIVE_AI_API_KEY to enable"}>
                <input type="radio" name="mode" checked={agentMode === "live"} disabled={!llm} onChange={() => setAgentMode("live")} />
                Live agent (Gemini){!llm && " — no key"}
              </label>
              <label>
                <input type="radio" name="mode" checked={agentMode === "cached"} onChange={() => setAgentMode("cached")} />
                {view.scenario ? "Cached trace" : "Rule-based shopper"}
              </label>
            </div>
            <span className="spacer" />
            <button onClick={() => act("run", `/api/mandates/${m.id}/run`, { agentMode })} disabled={busy !== null}>
              {busy === "run" ? "Agent is shopping…" : "Run agent"}
            </button>
          </div>
        </section>
      )}

      {d && (
        <section style={{ marginTop: 16 }}>
          {d.outcome === "CAPTURED" ? (
            <div className="outcome pass">
              <strong>Captured {usd(d.capturedAmountCents ?? 0)}</strong>
              <p>
                All hard rules passed. Only the final total was captured; {usd((m.authorizedAmountCents ?? 0) - (d.capturedAmountCents ?? 0))} of
                the hold was released.
              </p>
            </div>
          ) : (
            <div className="outcome fail">
              <strong>Blocked: authorization voided</strong>
              <p>
                {d.failedRules.includes("NO_PROPOSAL")
                  ? "The agent did not propose a purchase."
                  : `Failed ${d.failedRules.join(", ")}${d.totalCents ? ` on a ${usd(d.totalCents)} total` : ""}.`}{" "}
                No money moved; the whole hold was released.
              </p>
            </div>
          )}
        </section>
      )}

      {d && d.results.length > 0 && (
        <div className="grid2">
          <section className="card">
            <h2>Firewall: hard rules</h2>
            <RulesTable results={d.results} />
          </section>
          <section className="card">
            <h2>Server-computed total</h2>
            <table className="rules">
              <tbody>
                {lines.map((l) => (
                  <tr key={l.label}>
                    <td style={{ fontWeight: 400, whiteSpace: "normal" }}>{l.label}</td>
                    <td style={{ textAlign: "right" }}>{l.amount}</td>
                  </tr>
                ))}
                <tr>
                  <td>Total</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{d.totalCents != null ? usd(d.totalCents) : "—"}</td>
                </tr>
              </tbody>
            </table>
            {view.purchased && (
              <p className="muted small" style={{ marginBottom: 0 }}>
                Listing <span className="mono">{view.purchased.listing.id}</span> · sold by {view.purchased.listing.seller.name}
                {view.purchased.changedSinceSnapshot && <span className="pill fail" style={{ marginLeft: 8 }}>changed since snapshot</span>}
              </p>
            )}
          </section>
        </div>
      )}

      {m.status === "CAPTURED" && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Not what you asked for?</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            The arbiter compares the mandate, the flight recorder and the listing snapshot, decides who failed, and routes the cost.
          </p>
          <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={2} aria-label="Complaint" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => act("edit", `/api/mandates/${m.id}/merchant-edit`, {})} disabled={busy !== null}>
              Demo: merchant edits the listing
            </button>
            <span className="spacer" />
            <button className="danger" onClick={() => act("complain", `/api/mandates/${m.id}/complaint`, { text: complaint })} disabled={busy !== null || complaint.trim().length < 3}>
              {busy === "complain" ? "Arbiter is deciding…" : "Not what I asked for"}
            </button>
          </div>
        </section>
      )}

      {v && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className={`outcome ${v.fault ? (v.fault === "USER" ? "warn" : "pass") : "warn"}`}>
            <strong>
              {v.fault === "AGENT" && "Agent fault"}
              {v.fault === "MERCHANT" && "Merchant fault"}
              {v.fault === "USER" && "User responsibility"}
              {!v.fault && "Manual review"}
              <span className="pill" style={{ marginLeft: 10, verticalAlign: "middle" }}>
                {v.method} · confidence {v.confidence.toFixed(2)}
              </span>
            </strong>
            <p>{v.settlementNote}</p>
          </div>
          <h3>Reasoning</h3>
          <p>{v.reasoning}</p>
          <h3>Evidence</h3>
          <ul className="evidence">
            {v.evidence.map((e, i) => (
              <li key={i}>
                <span className="src">
                  <span className="pill">{e.source.replace("_", " ")}</span>
                </span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Flight recorder</h2>
          <span className={`pill ${view.chain.ok ? "pass" : "fail"}`} title={`head ${view.chain.headHash}`}>
            {view.chain.ok ? `hash chain intact · ${view.chain.length} entries` : `chain broken at #${view.chain.brokenAtSeq}`}
          </span>
          <span className="spacer" />
          <span className="muted small">{view.snapshots.length} listing snapshot(s)</span>
        </div>
        <ol className="trace">
          {view.trace.map((e) => (
            <li key={e.seq} className={seen.current.has(e.seq) ? "" : "fresh"}>
              <span className="seq">#{e.seq}</span>
              <TraceBody e={e} />
              <span className="hash" title={`hash ${e.hash}\nprev ${e.prevHash}`}>
                {e.hash.slice(0, 10)}
              </span>
            </li>
          ))}
        </ol>
        {busy === "run" && <p className="muted small">Agent running…</p>}
      </section>

      <p className="row">
        <Link href="/">← New mandate</Link>
        <span className="spacer" />
        <Link href="/ledger">Audit ledger →</Link>
      </p>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "CAPTURED" || status === "SETTLED_AGENT" || status === "SETTLED_MERCHANT" ? "pass" : status === "VOIDED" ? "fail" : status === "MANUAL_REVIEW" || status === "DISPUTED" ? "warn" : "info";
  return <span className={`pill ${cls}`}>{status}</span>;
}

const PATH = ["DRAFT", "AUTHORIZED", "PROPOSED"];
function Stepper({ status }: { status: string }) {
  const steps =
    status === "VOIDED"
      ? [...PATH, "VOIDED"]
      : status.startsWith("SETTLED") || status === "MANUAL_REVIEW" || status === "DISPUTED"
        ? [...PATH, "CAPTURED", "DISPUTED", ...(status === "DISPUTED" ? [] : [status])]
        : [...PATH, "CAPTURED / VOIDED"];
  const idx = steps.indexOf(status);
  return (
    <div className="stepper" aria-label="Transaction lifecycle">
      {steps.map((s, i) => (
        <span key={s} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="arrow">→</span>}
          <span className={`step ${i < idx ? "done" : i === idx ? "current" : ""}`}>{s}</span>
        </span>
      ))}
    </div>
  );
}

function RulesTable({ results }: { results: RuleResult[] }) {
  return (
    <table className="rules">
      <thead>
        <tr>
          <th>Rule</th>
          <th></th>
          <th>Check</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r) => (
          <tr key={r.rule}>
            <td>
              {r.rule} {r.name}
            </td>
            <td>
              <span className={`pill ${r.pass ? "pass" : "fail"}`}>{r.pass ? "pass" : "fail"}</span>
            </td>
            <td className="small">{r.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type P = Record<string, unknown>;

function TraceBody({ e }: { e: TraceEvent }) {
  const p = (e.payload ?? {}) as P;
  const kind = (label: string, cls = "") => <span className={`kind ${cls}`}>{label}</span>;
  let head: React.ReactNode;
  let body: React.ReactNode = null;
  switch (e.type) {
    case "mandate_created":
      head = kind("Mandate created", "sentinel");
      body = <>extracted by {String(p.extractor)}</>;
      break;
    case "mandate_edited":
      head = kind("Mandate edited by user", "sentinel");
      break;
    case "order_created":
      head = kind("PayPal order created", "paypal");
      body = <>{String(p.orderId)} · intent AUTHORIZE · {String(p.amount)}</>;
      break;
    case "budget_authorized":
      head = kind("Budget held", "paypal");
      body = <>authorization {String(p.authorizationId)} · {String(p.amount)}</>;
      break;
    case "agent_started":
      head = kind("Agent started");
      body = <>requested mode: {String(p.requestedMode)}</>;
      break;
    case "agent_fallback":
      head = kind("Agent fallback", "bad");
      body = <>{String(p.reason)} → {String(p.to)}</>;
      break;
    case "agent_message":
      head = kind("Agent");
      body = <q>{String(p.text)}</q>;
      break;
    case "tool_call": {
      head = kind(`→ ${String(p.tool)}`);
      body = <code>{JSON.stringify(p.input)}</code>;
      break;
    }
    case "tool_result": {
      head = kind(`← ${String(p.tool)}`);
      if (p.tool === "search_catalog") {
        const rs = (p.results as { id: string; price: string; sponsored: boolean }[]) ?? [];
        body = (
          <>
            {rs.length} result(s): {rs.map((r) => `${r.id} ${r.price}${r.sponsored ? " (sponsored)" : ""}`).join(" · ")}
          </>
        );
      } else if (p.tool === "get_listing" && p.listing) {
        const l = p.listing as { title: string; price: string };
        body = <>{l.title} · {l.price}</>;
      } else body = <code>{JSON.stringify(p)}</code>;
      break;
    }
    case "listing_snapshot":
      head = kind("Listing snapshot", "sentinel");
      body = <>{String(p.listingId)} · sha256 {String(p.hash).slice(0, 16)}…</>;
      break;
    case "proposal":
      head = kind("Proposal");
      body = (
        <>
          {String(p.listingId)}
          {(p.addOnIds as string[])?.length ? ` + ${(p.addOnIds as string[]).join(", ")}` : ""} · <q>{String(p.rationale ?? "")}</q>
        </>
      );
      break;
    case "injection_scan": {
      const hits = (p.patternHits as { id: string }[]) ?? [];
      const llm = p.llm as { ran?: boolean; flagged?: boolean } | undefined;
      head = kind("Injection scan", p.flagged ? "bad" : "sentinel");
      body = (
        <>
          {p.flagged ? "FLAGGED" : "clean"}
          {hits.length > 0 && `: ${hits.map((h) => h.id).join(", ")}`}
          {llm?.ran ? ` · LLM: ${llm.flagged ? "flagged" : "clean"}` : " · LLM classifier not used"}
        </>
      );
      break;
    }
    case "policy_decision":
      head = kind(p.pass ? "Policy: all rules pass" : "Policy: blocked", p.pass ? "sentinel" : "bad");
      body = <>total {String(p.total)}{(p.failedRules as string[])?.length ? ` · failed ${(p.failedRules as string[]).join(", ")}` : ""}</>;
      break;
    case "paypal_capture":
      head = kind("PayPal capture", "paypal");
      body = <>{String(p.captureId)} · captured {String(p.captured)} · released {String(p.released)} · final_capture</>;
      break;
    case "paypal_void":
      head = kind("PayPal void", "paypal");
      body = <>{String(p.reason)} · released {String(p.released)}</>;
      break;
    case "paypal_error":
      head = kind(`PayPal error (${String(p.action)})`, "bad");
      body = <>{String(p.error)}</>;
      break;
    case "merchant_edit":
      head = kind("Merchant edited listing (simulated)", "bad");
      body = <>{String(p.listingId)}</>;
      break;
    case "complaint":
      head = kind("Complaint");
      body = <q>{String(p.text)}</q>;
      break;
    case "verdict":
      head = kind("Arbiter verdict", "sentinel");
      body = <>{String(p.fault ?? "undetermined")} · {String(p.method)} · confidence {Number(p.confidence).toFixed(2)} (threshold {String(p.threshold)})</>;
      break;
    case "settlement":
      head = kind("Settlement", "paypal");
      body = <>{String(p.action)}{p.refundId ? ` · ${String(p.refundId)}` : ""}{p.payoutBatchId ? ` · ${String(p.payoutBatchId)}` : ""}{p.amount ? ` · ${String(p.amount)}` : ""}{p.note ? ` · ${String(p.note)}` : ""}</>;
      break;
    case "webhook_confirmed":
      head = kind("Webhook confirmed", "paypal");
      body = <>{String(p.eventType)}{p.simulated ? " (simulated)" : ""}</>;
      break;
    default:
      head = kind(e.type);
      body = <code>{JSON.stringify(p)}</code>;
  }
  return (
    <div>
      {head} <span className="body">{body}</span>
    </div>
  );
}
