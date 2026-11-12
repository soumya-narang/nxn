import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { ShieldCheck } from "lucide-react";
import { paypalMode } from "@/lib/paypal";
import { modelName } from "@/lib/llm";
import { Nav } from "@/components/Nav";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Sentinel home">
            <span className="brand-mark" aria-hidden>
              <ShieldCheck size={16} strokeWidth={2.4} />
            </span>
            Sentinel
          </Link>
          <Nav />
          <div className="modes">
            <span
              className="mode"
              title={mode === "sandbox" ? "Real PayPal Sandbox REST API. No real money moves." : "No PayPal credentials: in-process simulator, no network calls"}
            >
              <span className={`dot ${mode === "sandbox" ? "on" : "sim"}`} aria-hidden />
              <span className="mode-label">PayPal {mode === "sandbox" ? "Sandbox" : mode === "mock" ? "simulated" : "misconfigured"}</span>
            </span>
            <span className="mode" title={model ? `Gemini via the Vercel AI SDK (${model})` : "No Gemini key: rule-based parser and cached agent traces"}>
              <span className={`dot ${model ? "on" : "sim"}`} aria-hidden />
              <span className="mode-label">{model ? "Gemini live" : "AI offline"}</span>
            </span>
          </div>
        </header>
        {children}
        <footer className="footer">
          Hackathon prototype on the PayPal Sandbox. No real money moves. The store, brands and products are fictional.
        </footer>
      </body>
    </html>
  );
}
