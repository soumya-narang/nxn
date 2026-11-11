import { LedgerGrid } from "@/components/LedgerGrid";

export const dynamic = "force-dynamic";

export default function LedgerPage() {
  return (
    <main className="page wide">
      <h1>Audit ledger</h1>
      <p className="lead">Every mandate, firewall decision, PayPal id and verdict. Read-only. Demo data resets when the server restarts.</p>
      <LedgerGrid />
    </main>
  );
}
