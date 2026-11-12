"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeftRight,
  Ban,
  BellRing,
  Bot,
  Camera,
  Check,
  CircleDollarSign,
  Copy,
  CornerDownRight,
  FileText,
  Gavel,
  Landmark,
  Link2,
  Loader2,
  MessageSquare,
  MessageSquareWarning,
  PenLine,
  Pencil,
  Play,
  Receipt,
  ScanSearch,
  ShieldCheck,
  ShieldX,
  ShoppingCart,
  Wrench,
  X,
} from "lucide-react";
import type { MandateView } from "@/lib/view";
import type { TraceEvent } from "@/lib/recorder";
import type { RuleResult } from "@/lib/policy";
import { BudgetMeter, partsFrom, type MeterState } from "./BudgetMeter";
import { MoneyFlow } from "./MoneyFlow";
import { api, usd } from "./api";

interface Props {
  initial: MandateView;
  llm: boolean;
  paypalMode: "sandbox" | "mock";
}

type Mode = "live" | "sloppy" | "cached";

export function RunClient({ initial, llm, paypalMode }: Props) {
  const [view, setView] = useState<MandateView>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Scenarios 2 and 3 need a misbehaving agent; the careful one usually avoids both traps.
  const [agentMode, setAgentMode] = useState<Mode>(!llm ? "cached" : initial.scenario && initial.scenario.key !== "safe" ? "sloppy" : "live");
  const [complaint, setComplaint] = useState(initial.scenario?.complaint ?? "This isn't what I asked for.");
  const [pollUntil, setPollUntil] = useState(() => Date.now() + 5000);
  const [justDecided, setJustDecided] = useState(false);
  const seen = useRef(new Set(initial.trace.map((e) => e.seq)));

  const m = view.mandate;
  const refresh = useCallback(async () => {
    const v = await api<MandateView>(`/api/mandates/${m.id}`);
    setView(v);
    return v;
  }, [m.id]);

  // Poll while something is in flight, and for a while after, so the trace streams in and webhooks show up.
  useEffect(() => {
    if (!busy && Date.now() > pollUntil) return;
    const t = setInterval(() => {
      if (!busy && Date.now() > pollUntil) return clearInterval(t);
      refresh().catch(() => {});
    }, busy ? 450 : 2000);
    return () => clearInterval(t);
  }, [busy, pollUntil, refresh]);

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
      if (label === "run") setJustDecided(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh().catch(() => {});
      setPollUntil(Date.now() + 20_000);
      setBusy(null);
    }
  }

  const d = view.decision;
  const v = view.verdict;
  const hold = m.authorizedAmountCents ?? m.rules.ceilingCents;
  const meterState: MeterState = !d ? "preview" : d.outcome === "VOIDED" ? "voided" : v?.refundId ? "refunded" : "captured";
  const parts = partsFrom(view.breakdown);
  const verdictEvent = [...view.trace].reverse().find((e) => e.type === "verdict");
  const threshold = Number((verdictEvent?.payload as { threshold?: number } | undefined)?.threshold ?? 0.7);

  return (
    <>
      <div className="run-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>“{m.rawIntent}”</h1>
          <div className="meta">
            <StatusBadge status={m.status} />
            {view.scenario && <span className="badge">Demo case: {view.scenario.title.replace(/^\d\.\s*/, "")}</span>}
            <span className="mono tiny muted">{m.id}</span>
          </div>
        </div>
      </div>

      <Lifecycle status={m.status} />

      {error && (
        <p className="alert error" role="alert" style={{ marginTop: 16 }}>
          <AlertTriangle size={16} aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <section className="money" aria-label="Money">
        <div className="money-body">
          <BudgetMeter
            holdCents={hold}
            parts={parts}
            state={meterState}
            animate={justDecided}
            title={
              <>
                <span className="ink2 small">{d ? (d.outcome === "CAPTURED" ? "Bought" : d.listingId ? "Proposed" : "No purchase proposed") : "Budget held by PayPal"}</span>
                {view.breakdown && <h2 style={{ marginTop: 2 }}>{view.breakdown.title}</h2>}
              </>
            }
            figure={<Headline state={meterState} d={d} hold={hold} refunded={Boolean(v?.refundId)} />}
          />
        </div>
        <NextStep
          view={view}
          busy={busy}
          llm={llm}
          agentMode={agentMode}
          setAgentMode={setAgentMode}
          complaint={complaint}
          setComplaint={setComplaint}
          act={act}
        />
      </section>

      <div className="split-wide section">
        <section className="panel" aria-labelledby="gate-h">
          <div className="section-head" style={{ marginBottom: 14 }}>
            <h2 id="gate-h">Firewall</h2>
            <p>{d && d.results.length ? `${d.results.filter((r) => r.pass).length} of ${d.results.length} hard rules passed` : "Seven hard rules, checked in code before any capture"}</p>
          </div>
          <Gate results={d?.results ?? []} reveal={justDecided} noProposal={Boolean(d?.failedRules.includes("NO_PROPOSAL"))} />
        </section>

        <section className="panel" aria-labelledby="pp-h">
          <div className="section-head" style={{ marginBottom: 10 }}>
            <h2 id="pp-h">PayPal</h2>
            <span className={`badge ${paypalMode === "sandbox" ? "pass" : "hold"}`}>{paypalMode === "sandbox" ? "Sandbox API" : "Simulated"}</span>
          </div>
          <dl className="receipts">
            <Receipt_ label="Order" icon={<Receipt size={14} />} value={m.paypalOrderId} />
            <Receipt_ label={`Hold${m.authorizedAmountCents ? ` ${usd(m.authorizedAmountCents)}` : ""}`} icon={<Landmark size={14} />} value={m.authorizationId} />
            <Receipt_ label={`Capture${d?.capturedAmountCents ? ` ${usd(d.capturedAmountCents)}` : ""}`} icon={<CircleDollarSign size={14} />} value={d?.captureId ?? null} />
            <Receipt_ label="Refund" icon={<ArrowLeftRight size={14} />} value={v?.refundId ?? null} />
            <Receipt_ label="Bond payout" icon={<Gavel size={14} />} value={v?.payoutId ?? null} />
          </dl>
          <div className="hooks" aria-label="Webhooks">
            {view.webhooks.length === 0 ? (
              <span className="small muted">
                <BellRing size={13} aria-hidden style={{ verticalAlign: -2 }} /> No webhooks received yet
              </span>
            ) : (
              view.webhooks.map((w) => (
                <span key={w.id} className={`badge ${w.verified ? "pass" : "fail"}`} title={`${w.id}${w.simulated ? " (simulated)" : ""}`}>
                  {w.verified ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />}
                  {w.eventType.replace("PAYMENT.", "").toLowerCase().replace(/_/g, " ")}
                </span>
              ))
            )}
          </div>
        </section>
      </div>

      {v && (
        <section className="panel section" aria-labelledby="verdict-h">
          <div className="verdict-head">
            <span className={`verdict-icon ${v.fault === "USER" ? "hold" : v.fault ? "pass" : "review"}`} aria-hidden>
              <Gavel size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <h2 id="verdict-h">{VERDICT_TITLE[v.fault ?? "NONE"]}</h2>
              <p className="ink2" style={{ marginTop: 2 }}>
                {v.settlementNote}
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="small ink2">{v.method === "mechanical" ? "Decided by rules" : v.method === "llm" ? "Decided by Gemini, quotes verified" : "Undecided"}</div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 4, gap: 8 }}>
                <span className="confidence" title={`Confidence ${v.confidence.toFixed(2)}, threshold ${threshold}`}>
                  <span style={{ width: `${v.confidence * 100}%` }} />
                  <i style={{ left: `${threshold * 100}%` }} />
                </span>
                <span className="small num">{Math.round(v.confidence * 100)}%</span>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <h3>Who pays</h3>
            <div style={{ maxWidth: 760, margin: "0 auto" }}>
              <MoneyFlow fault={v.fault} amountCents={d?.capturedAmountCents ?? 0} refunded={Boolean(v.refundId)} bondPaid={Boolean(v.payoutId)} />
            </div>
          </div>
          <div style={{ marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
            <div>
              <h3 style={{ marginBottom: 4 }}>Why</h3>
              <p className="ink2" style={{ marginBottom: 14, maxWidth: "75ch" }}>
                {v.reasoning}
              </p>
              <div className="evidence">
                {v.evidence.map((e, i) => (
                  <blockquote key={i} className={`quote ${e.source}`} style={{ margin: 0 }}>
                    <span className="src">{SOURCE_LABEL[e.source] ?? e.source}</span>
                    {e.text}
                  </blockquote>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="panel section" aria-labelledby="fr-h">
        <div className="section-head" style={{ marginBottom: 6 }}>
          <h2 id="fr-h">Flight recorder</h2>
          <span className={`chain ${view.chain.ok ? "ok" : "bad"}`} title={`Head hash ${view.chain.headHash}`}>
            {view.chain.ok ? <Link2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
            {view.chain.ok ? `Hash chain intact, ${view.chain.length} entries` : `Chain broken at entry ${view.chain.brokenAtSeq}`}
          </span>
          <span className="spacer" />
          <span className="lanes" aria-label="Legend">
            <span>
              <i className="dot" style={{ background: "var(--lane-user)" }} /> You
            </span>
            <span>
              <i className="dot" style={{ background: "var(--lane-agent)" }} /> Agent
            </span>
            <span>
              <i className="dot" style={{ background: "var(--lane-sentinel)" }} /> Sentinel
            </span>
            <span>
              <i className="dot" style={{ background: "var(--lane-paypal)" }} /> PayPal
            </span>
          </span>
        </div>
        <p className="small muted">Every step is appended to a tamper-evident log. The arbiter refuses to judge if any entry was changed.</p>
        <ol className="timeline">
          {view.trace.map((e) => (
            <TraceRow key={e.seq} e={e} fresh={!seen.current.has(e.seq)} />
          ))}
          {busy === "run" && (
            <li className="tl agent">
              <span className="tl-icon">
                <Loader2 size={14} className="spin" aria-hidden />
              </span>
              <div className="tl-body tl-detail">The agent is working…</div>
              <span />
            </li>
          )}
        </ol>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function Headline({ state, d, hold, refunded }: { state: MeterState; d: MandateView["decision"]; hold: number; refunded: boolean }) {
  if (state === "preview")
    return (
      <span className="meter-figure">
        {usd(hold)}
        <small>on hold</small>
      </span>
    );
  if (state === "voided")
    return (
      <span className="meter-figure" style={{ color: "var(--fail)" }}>
        $0.00<small>charged</small>
      </span>
    );
  return (
    <span className="meter-figure" style={{ color: refunded ? "var(--pass)" : undefined }}>
      {usd(d?.capturedAmountCents ?? 0)}
      <small>{refunded ? "captured, then refunded" : "captured"}</small>
    </span>
  );
}

function NextStep({
  view,
  busy,
  llm,
  agentMode,
  setAgentMode,
  complaint,
  setComplaint,
  act,
}: {
  view: MandateView;
  busy: string | null;
  llm: boolean;
  agentMode: Mode;
  setAgentMode: (m: Mode) => void;
  complaint: string;
  setComplaint: (s: string) => void;
  act: (label: string, path: string, body: unknown) => Promise<void>;
}) {
  const m = view.mandate;
  const d = view.decision;

  if (busy === "run" || (m.status === "AUTHORIZED" && m.runStartedAt) || m.status === "PROPOSED")
    return (
      <div className="next attention" aria-live="polite">
        <Loader2 size={20} className="spin" aria-hidden style={{ color: "var(--accent)" }} />
        <div className="next-text">
          <h2>The agent is shopping</h2>
          <p>Its searches and reads appear in the flight recorder below as they happen. Then Sentinel checks the proposal.</p>
        </div>
      </div>
    );

  if (m.status === "AUTHORIZED")
    return (
      <div className="next attention">
        <div className="next-text">
          <h2>Let the agent shop</h2>
          <p>It can search, read listings and propose one purchase. It cannot touch PayPal.</p>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Agent">
          <label title={llm ? "Gemini, briefed to compare listings carefully" : "Needs a Gemini API key"}>
            <input type="radio" name="mode" checked={agentMode === "live"} disabled={!llm} onChange={() => setAgentMode("live")} />
            <Bot size={14} aria-hidden /> Careful agent
          </label>
          <label title={llm ? "The same Gemini model, briefed to cut corners and obey seller text: a stand-in for a cheap or manipulated agent" : "Needs a Gemini API key"}>
            <input type="radio" name="mode" checked={agentMode === "sloppy"} disabled={!llm} onChange={() => setAgentMode("sloppy")} />
            <AlertTriangle size={14} aria-hidden /> Sloppy agent
          </label>
          <label title="Replays recorded decisions; every tool call and check still runs for real">
            <input type="radio" name="mode" checked={agentMode === "cached"} onChange={() => setAgentMode("cached")} />
            {view.scenario ? "Recorded run" : "Rule-based"}
          </label>
        </div>
        <button className="lg" onClick={() => act("run", `/api/mandates/${m.id}/run`, { agentMode })} disabled={busy !== null}>
          <Play size={16} aria-hidden /> Run the agent
        </button>
      </div>
    );

  if (m.status === "CAPTURED")
    return (
      <div className="next">
        <div className="next-text" style={{ flexBasis: "100%" }}>
          <h2>Not what you asked for?</h2>
          <p>The arbiter compares your request, the flight recorder and the listing snapshot, then routes the cost to whoever failed.</p>
        </div>
        <label htmlFor="complaint" className="sr-only">
          Your complaint
        </label>
        <textarea id="complaint" value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={1} style={{ flex: 1, minWidth: 260 }} />
        <button className="danger" onClick={() => act("complain", `/api/mandates/${m.id}/complaint`, { text: complaint })} disabled={busy !== null || complaint.trim().length < 3}>
          {busy === "complain" ? <Loader2 size={16} className="spin" aria-hidden /> : <MessageSquareWarning size={16} aria-hidden />}
          {busy === "complain" ? "Arbiter is deciding" : "File a complaint"}
        </button>
        <button className="ghost" onClick={() => act("edit", `/api/mandates/${m.id}/merchant-edit`, {})} disabled={busy !== null} title="Demo only: the fictional merchant quietly changes the listing after the sale">
          <PenLine size={15} aria-hidden /> Simulate a merchant edit
        </button>
      </div>
    );

  if (m.status === "VOIDED")
    return (
      <div className="next">
        <ShieldX size={22} aria-hidden style={{ color: "var(--fail)" }} />
        <div className="next-text">
          <h2>Blocked before any money moved</h2>
          <p>
            {d?.failedRules.includes("NO_PROPOSAL")
              ? "The agent did not propose a purchase, so the hold was voided."
              : `Failed ${d?.failedRules.join(", ")}. PayPal voided the authorization and released the whole ${usd(m.authorizedAmountCents ?? 0)} hold.`}
          </p>
        </div>
        <Link className="btn ghost" href="/">
          Start a new purchase
        </Link>
      </div>
    );

  if (m.status === "DRAFT")
    return (
      <div className="next">
        <div className="next-text">
          <h2>Waiting for the PayPal hold</h2>
          <p>Approve the budget on the purchase page first.</p>
        </div>
        <Link className="btn ghost" href="/">
          Go to approval
        </Link>
      </div>
    );

  return (
    <div className="next">
      <Check size={22} aria-hidden style={{ color: "var(--pass)" }} />
      <div className="next-text">
        <h2>Case closed</h2>
        <p>{view.verdict?.settlementNote}</p>
      </div>
      <Link className="btn ghost" href="/ledger">
        View in the ledger
      </Link>
      <Link className="btn ghost" href="/">
        New purchase
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  DRAFT: { text: "Draft", tone: "" },
  AUTHORIZED: { text: "Hold placed", tone: "hold" },
  PROPOSED: { text: "Checking", tone: "info" },
  VOIDED: { text: "Blocked", tone: "fail" },
  CAPTURED: { text: "Captured", tone: "pass" },
  DISPUTED: { text: "Disputed", tone: "hold" },
  SETTLED_AGENT: { text: "Settled: agent at fault", tone: "pass" },
  SETTLED_MERCHANT: { text: "Settled: merchant at fault", tone: "pass" },
  SETTLED_USER: { text: "Settled: return policy", tone: "hold" },
  MANUAL_REVIEW: { text: "Manual review", tone: "review" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { text: status, tone: "" };
  return <span className={`badge ${s.tone}`}>{s.text}</span>;
}

function Lifecycle({ status }: { status: string }) {
  type N = { key: string; label: string; tone: string };
  const nodes: N[] = [
    { key: "DRAFT", label: "Drafted", tone: "info" },
    { key: "AUTHORIZED", label: "Hold placed", tone: "hold" },
    { key: "PROPOSED", label: "Proposal checked", tone: "info" },
  ];
  if (status === "VOIDED") nodes.push({ key: "VOIDED", label: "Blocked, hold voided", tone: "fail" });
  else {
    nodes.push({ key: "CAPTURED", label: ["DRAFT", "AUTHORIZED", "PROPOSED"].includes(status) ? "Captured or blocked" : "Captured", tone: "pass" });
    nodes.push({ key: "DISPUTED", label: "Disputed", tone: "hold" });
    const end: Record<string, N> = {
      SETTLED_AGENT: { key: "SETTLED_AGENT", label: "Agent's bond pays", tone: "pass" },
      SETTLED_MERCHANT: { key: "SETTLED_MERCHANT", label: "Merchant pays", tone: "pass" },
      SETTLED_USER: { key: "SETTLED_USER", label: "Return policy", tone: "hold" },
      MANUAL_REVIEW: { key: "MANUAL_REVIEW", label: "Human review", tone: "review" },
    };
    nodes.push(end[status] ?? { key: "END", label: "Settled", tone: "pass" });
  }
  const idx = nodes.findIndex((n) => n.key === status);
  return (
    <div className="lifecycle" aria-label="Transaction lifecycle">
      {nodes.map((n, i) => (
        <div key={n.key} style={{ display: "contents" }}>
          {i > 0 && <span className={`lc-line ${i <= idx ? "done" : ""}`} />}
          <div className={`lc-node ${i < idx ? "done" : i === idx ? `current tone-${n.tone}` : ""}`} aria-current={i === idx ? "step" : undefined}>
            <span className="lc-dot">{i < idx ? <Check size={12} strokeWidth={3} /> : i === idx && n.tone === "fail" ? <X size={12} strokeWidth={3} /> : null}</span>
            <span className="lc-label">{n.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const RULE_PLAIN: Record<string, string> = {
  R1: "Within budget",
  R2: "Right category",
  R3: "No recurring charges",
  R4: "Trusted seller",
  R5: "Arrives in time",
  R6: "Listing integrity",
  R7: "PayPal authorization",
};

function Gate({ results, reveal, noProposal }: { results: RuleResult[]; reveal: boolean; noProposal: boolean }) {
  if (!results.length)
    return (
      <>
        <div className="gate-summary" aria-hidden>
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className="gate-pip empty" />
          ))}
        </div>
        <p className="small ink2">
          {noProposal
            ? "Nothing to check: the agent did not propose a purchase."
            : "Budget, category, recurring charges, seller, delivery, listing integrity and the PayPal authorization. Results appear here when the agent proposes a purchase."}
        </p>
      </>
    );
  return (
    <>
      <div className="gate-summary" aria-hidden>
        {results.map((r) => (
          <span key={r.rule} className={`gate-pip ${r.pass ? "" : "fail"}`} />
        ))}
      </div>
      <ul className={`gate ${reveal ? "reveal" : ""}`}>
        {results.map((r, i) => (
          <li key={r.rule} className={r.pass ? "pass" : "fail"} style={{ ["--i" as string]: i }}>
            <span className={`mark ${r.pass ? "pass" : "fail"}`} aria-label={r.pass ? "passed" : "failed"}>
              {r.pass ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
            </span>
            <span className="name">
              {RULE_PLAIN[r.rule] ?? r.name} <span className="rid">{r.rule}</span>
            </span>
            <span className="detail">{r.detail}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Receipt_({ label, icon, value }: { label: string; icon: React.ReactNode; value: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dt>
        <span aria-hidden style={{ display: "inline-flex", color: "var(--muted)" }}>
          {icon}
        </span>
        {label}
      </dt>
      <dd>
        {value ? (
          <>
            <span>{value}</span>
            <button
              className="copy"
              aria-label={`Copy ${label} id`}
              onClick={() => {
                navigator.clipboard?.writeText(value).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </>
        ) : (
          <span className="none">Not yet</span>
        )}
      </dd>
    </>
  );
}

const VERDICT_TITLE: Record<string, string> = {
  AGENT: "The agent was at fault",
  MERCHANT: "The merchant was at fault",
  USER: "Your request didn't cover this",
  NONE: "Sent to a person for review",
};

const SOURCE_LABEL: Record<string, string> = {
  mandate: "Your request",
  snapshot: "Listing as the agent saw it",
  current_listing: "Listing now",
  complaint: "Your complaint",
  trace: "Flight recorder",
};

// ---------------------------------------------------------------------------

type P = Record<string, unknown>;
type Lane = "agent" | "sentinel" | "paypal" | "user";

function TraceRow({ e, fresh }: { e: TraceEvent; fresh: boolean }) {
  const p = (e.payload ?? {}) as P;
  let lane: Lane = "sentinel";
  let Icon: React.ComponentType<{ size?: number }> = ShieldCheck;
  let title: React.ReactNode = e.type;
  let detail: React.ReactNode = null;
  let tone: "" | "bad" | "good" = "";
  let minor = false;

  switch (e.type) {
    case "mandate_created":
      lane = "user";
      Icon = FileText;
      title = "Request turned into rules";
      detail = p.extractor === "llm" ? "Extracted by Gemini" : "Extracted by the rule-based parser";
      break;
    case "mandate_edited":
      lane = "user";
      Icon = Pencil;
      title = "Rules edited";
      break;
    case "order_created":
      lane = "paypal";
      Icon = Receipt;
      title = `Order created for ${String(p.amount)}`;
      detail = <code>{String(p.orderId)}</code>;
      break;
    case "budget_authorized":
      lane = "paypal";
      Icon = Landmark;
      title = `Hold placed: ${String(p.amount)}`;
      detail = <code>{String(p.authorizationId)}</code>;
      break;
    case "agent_started":
      lane = "agent";
      Icon = Bot;
      title = "Agent started";
      detail = { live: "Careful Gemini agent", sloppy: "Sloppy Gemini agent (red team)", cached: "Recorded run" }[String(p.requestedMode)] ?? String(p.requestedMode);
      break;
    case "agent_fallback":
      Icon = AlertTriangle;
      tone = "bad";
      title = "Agent fell back";
      detail = `${String(p.reason)}. Using ${String(p.to)} instead.`;
      break;
    case "agent_message":
      lane = "agent";
      Icon = MessageSquare;
      title = <q>{String(p.text)}</q>;
      break;
    case "tool_call":
      lane = "agent";
      Icon = Wrench;
      title = toolTitle(String(p.tool), p.input as P);
      break;
    case "tool_result": {
      lane = "agent";
      Icon = CornerDownRight;
      minor = true;
      if (p.tool === "search_catalog") {
        const rs = (p.results as { id: string; title: string; price: string; sponsored: boolean }[]) ?? [];
        title = `${rs.length} result${rs.length === 1 ? "" : "s"}`;
        detail = rs.map((r) => `${r.title} ${r.price}${r.sponsored ? " (sponsored)" : ""}`).join("; ");
      } else if (p.tool === "get_listing" && p.listing) {
        const l = p.listing as { title: string; price: string };
        title = `Read ${l.title}, ${l.price}`;
      } else if (p.tool === "propose_purchase") {
        title = p.status === "submitted" ? "Proposal handed to Sentinel" : String(p.ignored ?? p.status);
      } else title = String(p.error ?? "Result");
      break;
    }
    case "listing_snapshot":
      Icon = Camera;
      minor = true;
      title = "Snapshot of the listing saved";
      detail = <code>sha256 {String(p.hash).slice(0, 16)}</code>;
      break;
    case "proposal": {
      lane = "agent";
      Icon = ShoppingCart;
      const addOns = (p.addOnIds as string[]) ?? [];
      title = `Proposed ${String(p.listingId)}${addOns.length ? ` with ${addOns.join(", ")}` : ""}`;
      detail = p.rationale ? <q>{String(p.rationale)}</q> : null;
      break;
    }
    case "injection_scan": {
      const hits = (p.patternHits as { id: string; why: string }[]) ?? [];
      const llm = p.llm as { ran?: boolean; flagged?: boolean; reason?: string } | undefined;
      Icon = ScanSearch;
      tone = p.flagged ? "bad" : "";
      title = p.flagged ? "Hidden instructions found in the listing" : "No hidden instructions in the listing";
      detail = [hits.length ? `Patterns: ${hits.map((h) => h.why).join(", ")}.` : "", llm?.ran ? `Gemini classifier: ${llm.flagged ? "flagged" : "clean"}${llm.reason ? `, “${llm.reason}”` : ""}` : "Gemini classifier not used."]
        .filter(Boolean)
        .join(" ");
      break;
    }
    case "policy_decision":
      Icon = p.pass ? ShieldCheck : ShieldX;
      tone = p.pass ? "good" : "bad";
      title = p.pass ? `All seven rules passed on ${String(p.total)}` : `Blocked: ${(p.failedRules as string[]).join(", ")} failed on ${String(p.total)}`;
      break;
    case "paypal_capture":
      lane = "paypal";
      Icon = CircleDollarSign;
      tone = "good";
      title = `Captured ${String(p.captured)}, released ${String(p.released)}`;
      detail = <code>{String(p.captureId)}</code>;
      break;
    case "paypal_void":
      lane = "paypal";
      Icon = Ban;
      title = `Hold voided, ${String(p.released)} released`;
      detail = String(p.reason);
      break;
    case "paypal_error":
      lane = "paypal";
      Icon = AlertTriangle;
      tone = "bad";
      title = `PayPal error during ${String(p.action)}`;
      detail = String(p.error);
      break;
    case "merchant_edit":
      Icon = PenLine;
      tone = "bad";
      title = "Merchant edited the listing after the sale (simulated)";
      detail = String(p.listingId);
      break;
    case "complaint":
      lane = "user";
      Icon = MessageSquareWarning;
      title = "Complaint filed";
      detail = <q>{String(p.text)}</q>;
      break;
    case "verdict":
      Icon = Gavel;
      title = `Verdict: ${p.fault ? `${String(p.fault).toLowerCase()} at fault` : "undetermined"}`;
      detail = `${p.method === "llm" ? "Gemini" : p.method === "mechanical" ? "Rules" : "No method"}, confidence ${Number(p.confidence).toFixed(2)} (threshold ${String(p.threshold)})`;
      break;
    case "settlement":
      lane = "paypal";
      Icon = ArrowLeftRight;
      title =
        p.action === "refund"
          ? `Refunded ${String(p.amount)} to the buyer`
          : p.action === "bond_payout"
            ? `Bond paid ${String(p.amount)} to the merchant`
            : p.action === "payout_skipped"
              ? "Bond payout skipped"
              : "No money moved";
      detail = p.refundId ? <code>{String(p.refundId)}</code> : p.payoutBatchId ? <code>{String(p.payoutBatchId)}</code> : p.note ? String(p.note) : null;
      break;
    case "webhook_confirmed":
      lane = "paypal";
      Icon = BellRing;
      minor = true;
      title = `Webhook ${String(p.eventType).replace("PAYMENT.", "").toLowerCase().replace(/_/g, " ")}${p.simulated ? " (simulated)" : ", verified"}`;
      break;
  }

  return (
    <li className={`tl ${lane} ${tone} ${minor ? "minor" : ""} ${fresh ? "fresh" : ""}`}>
      <span className="tl-icon" aria-hidden>
<Icon size={14} />
      </span>
      <div className="tl-body">
        <div className="tl-title">{title}</div>
        {detail && <div className="tl-detail">{detail}</div>}
      </div>
      <span className="tl-hash" title={`Entry ${e.seq}\nhash ${e.hash}\nprev ${e.prevHash}`}>
        {e.hash.slice(0, 8)}
      </span>
    </li>
  );
}

function toolTitle(tool: string, input: P | undefined): string {
  if (tool === "search_catalog") return `Searched “${String(input?.query ?? "")}”${input?.maxPriceUsd ? ` up to $${String(input.maxPriceUsd)}` : ""}`;
  if (tool === "get_listing") return `Opened ${String(input?.listingId ?? "")}`;
  if (tool === "propose_purchase") return "Submitted a purchase proposal";
  return tool;
}
