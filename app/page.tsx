import { Gavel, Landmark, ShieldCheck } from "lucide-react";
import { HomeClient } from "@/components/HomeClient";
import { BudgetMeter } from "@/components/BudgetMeter";
import { paypalMode } from "@/lib/paypal";
import { llmAvailable } from "@/lib/llm";
import { SCENARIOS } from "@/lib/scenarios";
import { CATEGORIES, SELLERS } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default function Home() {
  let mode: "sandbox" | "mock" = "mock";
  let configError: string | null = null;
  try {
    mode = paypalMode();
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  return (
    <main className="page">
      <section className="hero">
        <div>
          <h1>Give your agent a budget, not your wallet.</h1>
          <p className="lede">
            Sentinel turns a sentence into rules, has PayPal hold the budget, and lets an AI agent shop on its own. Money only moves if every rule
            passes. If the agent still gets it wrong, Sentinel works out who pays.
          </p>
          <div className="hero-actions">
            <a className="btn lg" href="#start">
              Try a purchase
            </a>
            <a className="btn lg ghost" href="/ledger">
              Open the audit ledger
            </a>
          </div>
        </div>
        <div className="hero-stage" aria-label="Two example outcomes">
          <BudgetMeter
            holdCents={6000}
            state="captured"
            animate
            parts={[
              { kind: "item", label: "Webcam", cents: 4800 },
              { kind: "tax", label: "Tax", cents: 384 },
            ]}
            title={<h3>Agent picks a $48 USB-C webcam</h3>}
            figure={<span className="badge pass">Captured $51.84</span>}
          />
          <div style={{ height: 1, background: "var(--line)", margin: "18px 0 20px" }} />
          <BudgetMeter
            holdCents={6000}
            state="voided"
            animate
            parts={[
              { kind: "item", label: "Microphone", cents: 5500 },
              { kind: "tax", label: "Tax", cents: 440 },
              { kind: "addon", label: "Hidden protection plan", cents: 1499 },
            ]}
            title={<h3>A listing tells the agent to add a yearly plan</h3>}
            figure={<span className="badge fail">Blocked, nothing charged</span>}
          />
        </div>
      </section>

      <section className="stages" aria-label="How it works">
        <div className="stage">
          <span className="stage-icon hold" aria-hidden>
            <Landmark size={18} />
          </span>
          <h3>Hold the budget</h3>
          <p>You approve a ceiling once in PayPal. The agent never sees your credentials.</p>
          <p className="api mono">Orders v2, intent AUTHORIZE</p>
        </div>
        <div className="stage">
          <span className="stage-icon gate" aria-hidden>
            <ShieldCheck size={18} />
          </span>
          <h3>Gate every purchase</h3>
          <p>Seven hard rules run in plain code before any capture. Any failure voids the hold.</p>
          <p className="api mono">Capture with final_capture, or void</p>
        </div>
        <div className="stage">
          <span className="stage-icon recourse" aria-hidden>
            <Gavel size={18} />
          </span>
          <h3>Settle what slips through</h3>
          <p>An arbiter reads the evidence and decides whether the agent, merchant or user pays.</p>
          <p className="api mono">Refunds, plus a Payouts bond</p>
        </div>
      </section>

      {configError && (
        <p className="alert error" style={{ marginTop: 24 }}>
          {configError}
        </p>
      )}
      <HomeClient
        paypalMode={mode}
        paypalClientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || ""}
        llm={llmAvailable()}
        scenarios={SCENARIOS}
        categories={CATEGORIES}
        sellers={SELLERS}
      />
    </main>
  );
}
