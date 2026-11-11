import { notFound } from "next/navigation";
import { RunClient } from "@/components/RunClient";
import { services } from "@/lib/services";
import { mandateView } from "@/lib/view";
import { getMandate } from "@/lib/store";
import { llmAvailable } from "@/lib/llm";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ mandateId: string }> }) {
  const { mandateId } = await params;
  const { db, paypal } = services();
  if (!getMandate(db, mandateId)) notFound();
  return (
    <main className="page">
      <RunClient initial={mandateView(db, mandateId)} llm={llmAvailable()} paypalMode={paypal.mode} />
    </main>
  );
}
