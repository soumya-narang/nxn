import { usd } from "./format";

export type MeterPart = { kind: "item" | "ship" | "tax" | "addon"; label: string; cents: number };
export type MeterState = "preview" | "captured" | "voided" | "refunded";

interface Props {
  holdCents: number;
  parts: MeterPart[];
  state: MeterState;
  animate?: boolean;
  /** Shown above the bar, left. */
  title?: React.ReactNode;
  /** Shown above the bar, right: usually the headline amount. */
  figure?: React.ReactNode;
}

/**
 * The PayPal hold drawn as a ruler from $0 to the ceiling. The purchase fills
 * it part by part. Captured: the unused remainder is released. Blocked: what
 * exceeded the hold overflows past the ceiling line.
 */
export function BudgetMeter({ holdCents, parts, state, animate, title, figure }: Props) {
  const total = parts.reduce((s, p) => s + p.cents, 0);
  const scale = Math.max(holdCents, total * 1.04, 1);
  const pct = (c: number) => `${(c / scale) * 100}%`;
  const over = total > holdCents ? total - holdCents : 0;
  const released = state === "captured" || state === "refunded" ? Math.max(holdCents - total, 0) : 0;
  const ceilingAt = holdCents / scale;
  const totalAt = total / scale;

  const describe =
    state === "preview"
      ? `PayPal hold of ${usd(holdCents)}. Nothing spent yet.`
      : state === "voided"
        ? `Proposed total ${usd(total)} against a ${usd(holdCents)} hold. Blocked: the whole hold was released.`
        : `Captured ${usd(total)} of a ${usd(holdCents)} hold; ${usd(released)} released.`;

  return (
    <div className={`meter ${state} ${animate ? "animate" : ""}`}>
      {(title || figure) && (
        <div className="meter-head">
          <div>{title}</div>
          <div>{figure}</div>
        </div>
      )}
      <div className={`meter-track ${parts.length === 0 ? "empty" : ""}`} role="img" aria-label={describe}>
        {parts.length > 0 && (
          <div className="meter-fill" style={{ width: pct(total) }}>
            {parts.map((p, i) => (
              <div
                key={`${p.kind}-${i}`}
                className={`meter-seg ${p.kind}`}
                style={{ width: `${(p.cents / Math.max(total, 1)) * 100}%`, animationDelay: `${i * 90}ms` }}
                title={`${p.label}: ${usd(p.cents)}`}
              />
            ))}
          </div>
        )}
        {released > 0 && <div className="meter-released" style={{ left: pct(total), width: pct(released) }} title={`Released: ${usd(released)}`} />}
        {state === "voided" && over > 0 && (
          <div className="meter-over" style={{ left: pct(holdCents), width: pct(over) }} title={`Over the hold by ${usd(over)}`} />
        )}
        <div className="meter-ceiling" style={{ left: `calc(${ceilingAt * 100}% - 1px)` }} />
        <span className={`meter-mark top ${ceilingAt > 0.9 ? "edge-r" : ""}`} style={{ left: `${ceilingAt * 100}%` }}>
          Hold {usd(holdCents)}
        </span>
        <span className="meter-mark bottom edge-l" style={{ left: 0 }}>
          $0
        </span>
        {parts.length > 0 && total !== holdCents && (
          <span
            className={`meter-mark bottom ${totalAt > 0.9 ? "edge-r" : totalAt < 0.1 ? "edge-l" : ""}`}
            style={{ left: `${totalAt * 100}%`, color: "var(--ink)", fontWeight: 600 }}
          >
            {usd(total)}
          </span>
        )}
      </div>
      <div className="meter-legend">
        {parts.length === 0 && (
          <span>
            <i className="swatch hold" /> Held by PayPal, not yet spent
          </span>
        )}
        {parts.map((p, i) => (
          <span key={`l-${i}`}>
            <i className={`swatch ${p.kind}`} /> {p.label} <b className="num">{usd(p.cents)}</b>
          </span>
        ))}
        {released > 0 && (
          <span>
            <i className="swatch released" /> Released to buyer <b className="num">{usd(released)}</b>
          </span>
        )}
        {state === "refunded" && (
          <span style={{ color: "var(--pass)" }}>
            <i className="swatch" style={{ boxShadow: "inset 0 0 0 2px var(--pass)" }} /> Refunded after the verdict <b className="num">{usd(total)}</b>
          </span>
        )}
        {state === "voided" && over > 0 && (
          <span style={{ color: "var(--fail)" }}>
            <i className="swatch over" /> Over the hold <b className="num">{usd(over)}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/** Turns the server breakdown into meter parts. */
export function partsFrom(b: {
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  addOns: { name: string; cents: number; recurring: string | null }[];
} | null): MeterPart[] {
  if (!b) return [];
  const parts: MeterPart[] = [{ kind: "item", label: "Item", cents: b.itemCents }];
  if (b.shippingCents) parts.push({ kind: "ship", label: "Shipping", cents: b.shippingCents });
  parts.push({ kind: "tax", label: "Tax", cents: b.taxCents });
  for (const a of b.addOns) parts.push({ kind: "addon", label: a.recurring ? `${a.name}` : a.name, cents: a.cents });
  return parts;
}
