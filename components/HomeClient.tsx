"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { AlertCircle, Check, Info, Loader2, Lock, Scale, Sparkles } from "lucide-react";
import type { MandateRules } from "@/lib/mandate";
import type { Mandate } from "@/lib/store";
import type { Scenario } from "@/lib/scenarios";
import { BudgetMeter } from "./BudgetMeter";
import { api, usd } from "./api";

const PLATFORMS = ["Windows", "macOS", "Linux", "ChromeOS"];

const EXPECT: Record<string, { label: string; tone: string }> = {
  safe: { label: "Captures", tone: "pass" },
  blocked: { label: "Gets blocked", tone: "fail" },
  slipped: { label: "Gets disputed", tone: "review" },
};

const SHORT_TITLE: Record<string, string> = {
  safe: "Safe purchase",
  blocked: "Hidden instruction",
  slipped: "Wrong item, then refund",
};

interface Props {
  paypalMode: "sandbox" | "mock";
  paypalClientId: string;
  llm: boolean;
  scenarios: Scenario[];
  categories: string[];
  sellers: { id: string; name: string }[];
}

const STEPS = ["Describe it", "Check the rules", "Approve the hold", "Agent shops", "See the outcome"];

export function HomeClient({ paypalMode, paypalClientId, llm, scenarios, categories, sellers }: Props) {
  const router = useRouter();
  const [intent, setIntent] = useState(scenarios[0].intent);
  const [scenario, setScenario] = useState<string | null>(scenarios[0].key);
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [rules, setRules] = useState<MandateRules | null>(null);
  const [dirty, setDirty] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = !mandate ? 0 : busy === "approve" ? 2 : 1;

  async function extract() {
    setBusy("extract");
    setError(null);
    setMandate(null);
    try {
      const r = await api<{ mandate: Mandate; warnings: string[] }>("/api/mandates", { body: { intent, scenario } });
      setMandate(r.mandate);
      setRules(r.mandate.rules);
      setWarnings(r.warnings);
      setDirty(false);
      requestAnimationFrame(() => document.getElementById("review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function edit<K extends keyof MandateRules>(key: K, value: MandateRules[K]) {
    setRules((r) => (r ? { ...r, [key]: value } : r));
    setDirty(true);
  }

  /** Saves edits, then creates the AUTHORIZE order. Used by both PayPal paths. */
  async function createOrder(): Promise<string> {
    if (!mandate || !rules) throw new Error("No mandate");
    if (dirty) {
      const saved = await api<{ mandate: Mandate }>(`/api/mandates/${mandate.id}`, { method: "PATCH", body: { rules } });
      setMandate(saved.mandate);
      setDirty(false);
    }
    const { orderId } = await api<{ orderId: string }>(`/api/mandates/${mandate.id}/order`, { body: {} });
    return orderId;
  }

  async function authorize(orderId: string) {
    setBusy("approve");
    await api(`/api/mandates/${mandate!.id}/authorize`, { body: { orderId } });
    router.push(`/run/${mandate!.id}`);
  }

  async function approveSimulated() {
    setBusy("approve");
    setError(null);
    try {
      await authorize(await createOrder());
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div id="start" style={{ scrollMarginTop: 72 }}>
      <ol className="flow" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={`flow-step ${i < step ? "done" : i === step ? "current" : ""}`} aria-current={i === step ? "step" : undefined}>
            <span className="flow-num">{i < step ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <section aria-labelledby="describe-h">
        <div className="section-head">
          <h2 id="describe-h">What should the agent buy?</h2>
          <p>Start from a demo case, or write your own. The store is fictional.</p>
        </div>
        <div className="cases">
          {scenarios.map((s) => (
            <button
              key={s.key}
              type="button"
              className="case"
              aria-pressed={scenario === s.key}
              onClick={() => {
                setIntent(s.intent);
                setScenario(s.key);
                setMandate(null);
                setError(null);
              }}
            >
              <span className="case-top">
                <b>{SHORT_TITLE[s.key] ?? s.title}</b>
                <span className={`badge ${EXPECT[s.key]?.tone ?? ""}`}>{EXPECT[s.key]?.label}</span>
              </span>
              <small>{s.intent}</small>
            </button>
          ))}
        </div>
        <div className="panel composer">
          <label htmlFor="intent" className="sr-only">
            What should the agent buy?
          </label>
          <textarea
            id="intent"
            value={intent}
            onChange={(e) => {
              setIntent(e.target.value);
              setScenario(scenarios.find((s) => s.intent === e.target.value)?.key ?? null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) extract();
            }}
            rows={2}
            placeholder="e.g. Buy me wireless headphones under $90, delivered within 5 days"
          />
          <div className="composer-bar">
            <span className="muted small row" style={{ gap: 6 }}>
              <Sparkles size={14} aria-hidden />
              {llm ? "Gemini turns this into rules you can edit." : "A rule-based parser turns this into rules you can edit."}
            </span>
            <span className="spacer" />
            <button onClick={extract} disabled={busy !== null || intent.trim().length < 3}>
              {busy === "extract" ? (
                <>
                  <Loader2 size={16} className="spin" aria-hidden /> Reading your request
                </>
              ) : (
                "Turn into rules"
              )}
            </button>
          </div>
        </div>
        {error && !mandate && (
          <p className="alert error" role="alert" style={{ marginTop: 12 }}>
            <AlertCircle size={16} aria-hidden />
            <span>{error}</span>
          </p>
        )}
      </section>

      {mandate && rules && (
        <section id="review" className="section" aria-labelledby="review-h" style={{ scrollMarginTop: 72 }}>
          <div className="section-head">
            <h2 id="review-h">Check the rules</h2>
            <p>{mandate.extractor === "llm" ? "Extracted by Gemini." : "Extracted by the rule-based parser."} Edit anything before you approve.</p>
          </div>
          {warnings.map((w) => (
            <p key={w} className="alert note" style={{ marginBottom: 12 }}>
              <Info size={16} aria-hidden />
              <span>{w}</span>
            </p>
          ))}
          <div className="panel">
            <div className="rulegroup">
              <div className="rulegroup-head">
                <span className="icon hard" aria-hidden>
                  <Lock size={15} />
                </span>
                <div>
                  <h3>Checked before any money moves</h3>
                  <p>If any of these fail, the PayPal hold is voided and nothing is charged.</p>
                </div>
              </div>
              <div className="rulegrid">
                <label className="field">
                  <span className="label">Budget, all-in USD</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step="0.01"
                    value={rules.ceilingCents / 100}
                    onChange={(e) => edit("ceilingCents", Math.round(Number(e.target.value) * 100))}
                  />
                </label>
                <label className="field">
                  <span className="label">Category</span>
                  <select value={rules.category} onChange={(e) => edit("category", e.target.value)}>
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="label">Deliver within (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    placeholder="No deadline"
                    value={rules.maxDeliveryDays ?? ""}
                    onChange={(e) => edit("maxDeliveryDays", e.target.value ? Math.round(Number(e.target.value)) : null)}
                  />
                </label>
              </div>
              <div className="field" style={{ marginTop: 14 }}>
                <span className="label">Only buy from (none selected: any seller, as long as it does not change)</span>
                <div className="checks">
                  {sellers.map((s) => (
                    <label key={s.id} className="chip-toggle">
                      <input
                        type="checkbox"
                        checked={rules.allowedSellers.includes(s.id)}
                        onChange={(e) => edit("allowedSellers", e.target.checked ? [...rules.allowedSellers, s.id] : rules.allowedSellers.filter((x) => x !== s.id))}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="always" aria-label="Always enforced">
                <span className="badge info">
                  <Lock size={11} aria-hidden /> No subscriptions or protection plans
                </span>
                <span className="badge info">
                  <Lock size={11} aria-hidden /> No hidden instructions in the listing
                </span>
                <span className="badge info">
                  <Lock size={11} aria-hidden /> Listing unchanged since the agent read it
                </span>
                <span className="badge info">
                  <Lock size={11} aria-hidden /> Within the PayPal authorization
                </span>
              </div>
            </div>

            <div className="rulegroup" style={{ borderTop: "1px solid var(--line)", paddingTop: 20 }}>
              <div className="rulegroup-head">
                <span className="icon soft" aria-hidden>
                  <Scale size={15} />
                </span>
                <div>
                  <h3>Settled afterwards if the agent gets it wrong</h3>
                  <p>These cannot be proven before paying. If you complain, the arbiter checks them against what the agent saw.</p>
                </div>
              </div>
              <div className="rulegrid">
                <label className="field">
                  <span className="label">Must have</span>
                  <input
                    value={rules.requiredFeatures.join(", ")}
                    placeholder="e.g. USB-C, 4K"
                    onChange={(e) =>
                      edit(
                        "requiredFeatures",
                        e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                      )
                    }
                  />
                </label>
                <div className="field">
                  <span className="label">Must work with</span>
                  <div className="checks">
                    {PLATFORMS.map((p) => (
                      <label key={p} className="chip-toggle">
                        <input
                          type="checkbox"
                          checked={rules.compatibility.includes(p)}
                          onChange={(e) => edit("compatibility", e.target.checked ? [...rules.compatibility, p] : rules.compatibility.filter((x) => x !== p))}
                        />
                        {p}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {rules.notes.length > 0 && (
                <p className="small ink2" style={{ marginTop: 12 }}>
                  Also noted: {rules.notes.map((n) => `“${n}”`).join(", ")}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {mandate && rules && (
        <section className="section" aria-labelledby="approve-h">
          <div className="section-head">
            <h2 id="approve-h">Approve the hold</h2>
            <p>You approve a ceiling once, not an item. Only the final total is ever captured.</p>
          </div>
          <div className="panel">
            <BudgetMeter
              holdCents={Math.max(rules.ceilingCents, 0)}
              parts={[]}
              state="preview"
              title={<span className="ink2 small">PayPal will hold</span>}
              figure={<span className="meter-figure">{usd(Math.max(rules.ceilingCents, 0))}</span>}
            />
            <div style={{ marginTop: 20 }}>
              {error && (
                <p className="alert error" role="alert" style={{ marginBottom: 12 }}>
                  <AlertCircle size={16} aria-hidden />
                  <span>{error}</span>
                </p>
              )}
              {paypalMode === "sandbox" ? (
                paypalClientId ? (
                  <div className="row" style={{ alignItems: "flex-start", gap: 20 }}>
                    <div style={{ width: 300, maxWidth: "100%" }}>
                      <PayPalScriptProvider options={{ clientId: paypalClientId, currency: "USD", intent: "authorize" }}>
                        <PayPalButtons
                          style={{ layout: "vertical", label: "pay", height: 44 }}
                          fundingSource="paypal"
                          disabled={busy !== null}
                          createOrder={async () => {
                            setError(null);
                            try {
                              return await createOrder();
                            } catch (e) {
                              setError((e as Error).message);
                              throw e;
                            }
                          }}
                          onApprove={async (data) => {
                            try {
                              await authorize(data.orderID);
                            } catch (e) {
                              setError((e as Error).message);
                              setBusy(null);
                            }
                          }}
                          onError={(err) => setError(`PayPal could not open the approval window: ${String(err)}`)}
                        />
                      </PayPalScriptProvider>
                    </div>
                    <p className="small ink2" style={{ flex: 1, minWidth: 220, paddingTop: 4 }}>
                      {busy === "approve" ? (
                        <span className="row" style={{ gap: 6 }}>
                          <Loader2 size={14} className="spin" aria-hidden /> Placing the hold
                        </span>
                      ) : (
                        <>Log in with your PayPal Sandbox buyer account. Never use a real PayPal login here.</>
                      )}
                    </p>
                  </div>
                ) : (
                  <p className="alert error">
                    <AlertCircle size={16} aria-hidden />
                    <span>Set NEXT_PUBLIC_PAYPAL_CLIENT_ID to show the PayPal button.</span>
                  </p>
                )
              ) : (
                <div className="row">
                  <button className="lg" onClick={approveSimulated} disabled={busy !== null || rules.ceilingCents <= 0}>
                    {busy === "approve" ? (
                      <>
                        <Loader2 size={16} className="spin" aria-hidden /> Placing the hold
                      </>
                    ) : (
                      `Approve ${usd(rules.ceilingCents)} hold`
                    )}
                  </button>
                  <span className="small ink2">Simulated PayPal: no credentials are configured, so the hold is placed locally.</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
