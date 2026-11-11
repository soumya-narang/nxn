import type { Metadata } from "next";
import Link from "next/link";
import { paypalMode } from "@/lib/paypal";
import { modelName } from "@/lib/llm";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel",
  description: "A payment firewall and recourse layer for AI shopping agents, built on PayPal.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let mode: string;
  try {
    mode = paypalMode();
  } catch {
    mode = "refused";
  }
  const model = modelName();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            Sentinel<span>payment firewall for AI shopping agents</span>
          </Link>
          <nav className="nav">
            <Link href="/">New mandate</Link>
            <Link href="/ledger">Audit ledger</Link>
          </nav>
          <div className="modes">
            <span
              className={`pill ${mode === "sandbox" ? "pass" : "warn"}`}
              title={mode === "sandbox" ? "Real PayPal Sandbox REST API" : "No PayPal credentials: in-process simulator, no network calls"}
            >
              PayPal: {mode === "sandbox" ? "Sandbox" : mode === "mock" ? "Simulated" : "misconfigured"}
            </span>
            <span className={`pill ${model ? "pass" : "warn"}`} title={model ? "Gemini via Vercel AI SDK" : "No Gemini key: rule-based parser and cached agent traces"}>
              LLM: {model ?? "offline (cached traces)"}
            </span>
          </div>
        </header>
        {children}
        <footer className="footer">
          Hackathon prototype. PayPal Sandbox only: no real money moves. The store, brands and products are fictional.
        </footer>
      </body>
    </html>
  );
}
