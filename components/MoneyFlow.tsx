import { usd } from "./format";

type Fault = "AGENT" | "MERCHANT" | "USER" | null;

/** Who paid whom after the verdict. Buyer, merchant and agent operator, with the money paths between them. */
export function MoneyFlow({ fault, amountCents, refunded, bondPaid }: { fault: Fault; amountCents: number; refunded: boolean; bondPaid: boolean }) {
  const showRefund = refunded && (fault === "AGENT" || fault === "MERCHANT");
  const showBond = bondPaid && fault === "AGENT";
  const amount = usd(amountCents);
  const summary = [
    `Buyer paid ${amount} to the merchant.`,
    showRefund ? `Merchant refunded ${amount} to the buyer.` : "No refund.",
    showBond ? `Agent operator's bond paid ${amount} to the merchant.` : "",
  ].join(" ");
  return (
    <svg className="flowmap" viewBox="0 30 720 160" role="img" aria-label={summary}>
      <defs>
        {(["capture", "refund", "bond"] as const).map((k) => (
          <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={`ahead-${k}`} />
          </marker>
        ))}
      </defs>

      <Node x={10} title="Buyer" sub="you" active={showRefund} />
      <Node x={290} title="Merchant" sub="the seller" active={showRefund || showBond} />
      <Node x={570} title="Agent operator" sub="runs the AI agent" active={showBond} />

      <line className="edge capture" x1={150} y1={84} x2={286} y2={84} markerEnd="url(#ah-capture)" />
      <text className="elabel capture" x={220} y={74} textAnchor="middle">
        Paid {amount}
      </text>

      {showRefund && (
        <>
          <line className="edge refund" x1={290} y1={116} x2={154} y2={116} markerEnd="url(#ah-refund)" />
          <text className="elabel refund" x={220} y={138} textAnchor="middle">
            Refund {amount}
          </text>
        </>
      )}
      {showBond && (
        <>
          <line className="edge bond" x1={570} y1={100} x2={434} y2={100} markerEnd="url(#ah-bond)" />
          <text className="elabel bond" x={502} y={90} textAnchor="middle">
            Bond {amount}
          </text>
        </>
      )}
      {!showRefund && !showBond && (
        <text className="elabel capture" x={360} y={176} textAnchor="middle">
          {fault === "USER" ? "No automatic refund. The merchant's return policy applies." : "No money moves until a person reviews the evidence."}
        </text>
      )}
    </svg>
  );
}

function Node({ x, title, sub, active }: { x: number; title: string; sub: string; active: boolean }) {
  return (
    <g className="node">
      <rect x={x} y={60} width={140} height={80} rx={10} style={active ? { stroke: "var(--ink-2)", strokeWidth: 1.5 } : undefined} />
      <text x={x + 70} y={96} textAnchor="middle">
        {title}
      </text>
      <text className="sub" x={x + 70} y={116} textAnchor="middle">
        {sub}
      </text>
    </g>
  );
}
