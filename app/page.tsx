import { HomeClient } from "@/components/HomeClient";
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
      <h1>Give your agent a budget, not your wallet.</h1>
      <p className="lead">
        Describe what to buy. Sentinel turns it into enforceable rules, PayPal holds the budget, and the agent shops on its own. Money only
        moves if every hard rule passes.
      </p>
      {configError && <p className="error">{configError}</p>}
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
