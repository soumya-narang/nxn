"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import type { MandateRules } from "@/lib/mandate";
import type { Mandate } from "@/lib/store";
import type { Scenario } from "@/lib/scenarios";
import { api, usd } from "./api";

const PLATFORMS = ["Windows", "macOS", "Linux", "ChromeOS"];

interface Props {
  paypalMode: "sandbox" | "mock";
  paypalClientId: string;
  llm: boolean;
  scenarios: Scenario[];
  categories: string[];
  sellers: { id: string; name: string }[];
}

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
    <>
      <section className="card">
        <h2>1. Say what you want</h2>
        <div className="scenarios">
          {scenarios.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`scenario ${scenario === s.key ? "active" : ""}`}
              onClick={() => {
                setIntent(s.intent);
                setScenario(s.key);
                setMandate(null);
              }}
            >
              <b>{s.title}</b>
              <small>{s.intent}</small>
            </button>
          ))}
        </div>
        <textarea
          aria-label="What should the agent buy?"
          value={intent}
          onChange={(e) => {
            setIntent(e.target.value);
            setScenario(scenarios.find((s) => s.intent === e.target.value)?.key ?? null);
          }}
          rows={2}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted small">
            {llm ? "Gemini extracts the mandate; you can edit it before approving." : "No Gemini key: a rule-based parser extracts the mandate."}
          </span>
          <span className="spacer" />
          <button onClick={extract} disabled={busy !== null || intent.trim().length < 3}>
            {busy === "extract" ? "Extracting…" : "Extract mandate"}
          </button>
        </div>
        {error && !mandate && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      </section>

      {mandate && rules && (
        <section className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>2. Review the mandate</h2>
            <span className={`pill ${mandate.extractor === "llm" ? "info" : ""}`}>{mandate.extractor === "llm" ? "extracted by Gemini" : "rule-based parser"}</span>
            <span className="spacer" />
            <span className="mono muted small">{mandate.id}</span>
          </div>
          {warnings.map((w) => (
            <p key={w} className="notice">{w}</p>
          ))}
          <div className="fields">
            <label className="field">
              <span>Category (R2)</span>
              <select value={rules.category} onChange={(e) => edit("category", e.target.value)}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Budget ceiling, all-in USD (R1)</span>
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
              <span>Deliver within (days, R5)</span>
              <input
                type="number"
                min={1}
                max={60}
                placeholder="no deadline"
                value={rules.maxDeliveryDays ?? ""}
                onChange={(e) => edit("maxDeliveryDays", e.target.value ? Math.round(Number(e.target.value)) : null)}
              />
            </label>
            <label className="field">
              <span>Required features (soft)</span>
              <input
                value={rules.requiredFeatures.join(", ")}
                onChange={(e) =>
                  edit(
                    "requiredFeatures",
                    e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  )
                }
              />
            </label>
          </div>
          <div className="fields" style={{ marginTop: 14 }}>
            <div className="field">
              <span>Must work with (soft)</span>
              <div className="checks">
                {PLATFORMS.map((p) => (
                  <label key={p}>
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
            <div className="field">
              <span>Only these sellers (R4; none = any, but unchanged)</span>
              <div className="checks">
                {sellers.map((s) => (
                  <label key={s.id}>
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
          </div>
          <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
            Always enforced: <b>R3</b> no subscriptions or protection plans · <b>R6</b> no hidden instructions, listing unchanged since the agent read
            it · <b>R7</b> capture within the PayPal authorization. Soft constraints (features, compatibility) cannot be proven before capture: the
            arbiter settles them if something goes wrong.
          </p>
        </section>
      )}

      {mandate && rules && (
        <section className="card">
          <h2>3. Approve the budget in PayPal</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            You approve a <b>{usd(rules.ceilingCents)} hold</b> once, not an item. PayPal holds the funds; only Sentinel can capture, and only the
            final total if every rule passes. The rest is released.
          </p>
          {error && <p className="error">{error}</p>}
          {paypalMode === "sandbox" ? (
            paypalClientId ? (
              <div style={{ maxWidth: 380 }}>
                <PayPalScriptProvider options={{ clientId: paypalClientId, currency: "USD", intent: "authorize" }}>
                  <PayPalButtons
                    style={{ layout: "vertical", label: "pay" }}
                    fundingSource="paypal"
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
                      }
                    }}
                    onError={(err) => setError(`PayPal error: ${String(err)}`)}
                  />
                </PayPalScriptProvider>
                <p className="muted small">Log in with the sandbox buyer account. Never use real PayPal credentials.</p>
              </div>
            ) : (
              <p className="error">NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set.</p>
            )
          ) : (
            <div className="row">
              <button onClick={approveSimulated} disabled={busy !== null || rules.ceilingCents <= 0}>
                {busy === "approve" ? "Placing hold…" : `Approve ${usd(rules.ceilingCents)} hold (simulated PayPal)`}
              </button>
              <span className="muted small">No PayPal credentials configured: the hold is placed in the local simulator.</span>
            </div>
          )}
        </section>
      )}
    </>
  );
}
