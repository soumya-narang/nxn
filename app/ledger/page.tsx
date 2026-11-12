import { LedgerGrid } from "@/components/LedgerGrid";

export const dynamic = "force-dynamic";

export default function LedgerPage() {
  return (
    <main className="page wide">
      <div className="section-head" style={{ marginBottom: 18 }}>
        <h1>Audit ledger</h1>
        <p>Every purchase, firewall decision, PayPal id and verdict. Read-only; demo data resets when the server restarts.</p>
      </div>
      <LedgerGrid />
    </main>
  );
}
