"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { Link2, RotateCcw, ShieldX } from "lucide-react";
import type { LedgerRow } from "@/lib/view";
import { api, usd } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

// Grid colours follow the page tokens, so light and dark mode both work.
const theme = themeQuartz.withParams({
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  headerFontWeight: 600,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--ink-2)",
  borderColor: "var(--line)",
  accentColor: "var(--accent)",
  rowHoverColor: "var(--surface-2)",
  oddRowBackgroundColor: "var(--surface)",
  wrapperBorderRadius: 8,
});

const STATUS: Record<string, { text: string; tone: string }> = {
  DRAFT: { text: "Draft", tone: "" },
  AUTHORIZED: { text: "Hold placed", tone: "hold" },
  PROPOSED: { text: "Checking", tone: "info" },
  VOIDED: { text: "Blocked", tone: "fail" },
  CAPTURED: { text: "Captured", tone: "pass" },
  DISPUTED: { text: "Disputed", tone: "hold" },
  SETTLED_AGENT: { text: "Agent at fault", tone: "pass" },
  SETTLED_MERCHANT: { text: "Merchant at fault", tone: "pass" },
  SETTLED_USER: { text: "Return policy", tone: "hold" },
  MANUAL_REVIEW: { text: "Manual review", tone: "review" },
};

function StatusCell(p: ICellRendererParams<LedgerRow>) {
  const s = STATUS[p.value as string] ?? { text: String(p.value ?? ""), tone: "" };
  return (
    <span className="cell-badge">
      <span className={`badge ${s.tone}`}>{s.text}</span>
    </span>
  );
}

function RulesCell(p: ICellRendererParams<LedgerRow>) {
  if (!p.value) return p.data?.outcome ? <span className="muted">None</span> : null;
  return <span style={{ color: "var(--fail)", fontWeight: 600 }}>{p.value as string}</span>;
}

function ChainCell(p: ICellRendererParams<LedgerRow>) {
  return p.value ? (
    <span className="chain ok">
      <Link2 size={13} aria-hidden /> Intact
    </span>
  ) : (
    <span className="chain bad">Broken</span>
  );
}

const mono = { fontFamily: "var(--font-mono)", fontSize: 12 };

const columns: ColDef<LedgerRow>[] = [
  { field: "createdAt", headerName: "Created", width: 150, sort: "desc", valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "") },
  { field: "intent", headerName: "Request", flex: 2, minWidth: 280, tooltipField: "intent" },
  { field: "status", headerName: "Outcome", width: 170, cellRenderer: StatusCell },
  { field: "ceiling", headerName: "Hold", width: 95, type: "rightAligned" },
  { field: "total", headerName: "Total", width: 95, type: "rightAligned" },
  { field: "captured", headerName: "Captured", width: 105, type: "rightAligned" },
  { field: "failedRules", headerName: "Failed rules", width: 150, cellRenderer: RulesCell },
  { field: "confidence", headerName: "Verdict confidence", width: 150, valueFormatter: (p) => (p.value == null ? "" : `${Math.round(p.value * 100)}%`) },
  { field: "orderId", headerName: "PayPal order", width: 190, cellStyle: mono },
  { field: "authorizationId", headerName: "Authorization", width: 190, cellStyle: mono },
  { field: "captureId", headerName: "Capture", width: 190, cellStyle: mono },
  { field: "refundId", headerName: "Refund", width: 190, cellStyle: mono },
  { field: "payoutId", headerName: "Bond payout", width: 200, cellStyle: mono },
  { field: "webhooks", headerName: "Webhooks", width: 260, tooltipField: "webhooks" },
  { field: "chainOk", headerName: "Recorder", width: 110, cellRenderer: ChainCell },
  { field: "id", headerName: "Mandate", width: 150, cellStyle: mono },
];

const OUTCOME_GROUPS = [
  { key: "captured", label: "Captured", color: "var(--pass)", match: (s: string) => s === "CAPTURED" },
  { key: "blocked", label: "Blocked", color: "var(--fail)", match: (s: string) => s === "VOIDED" },
  { key: "settled", label: "Refunded after a complaint", color: "var(--seg-item)", match: (s: string) => s === "SETTLED_AGENT" || s === "SETTLED_MERCHANT" },
  { key: "user", label: "Return policy", color: "var(--hold)", match: (s: string) => s === "SETTLED_USER" },
  { key: "review", label: "Manual review", color: "var(--review)", match: (s: string) => s === "MANUAL_REVIEW" },
  { key: "open", label: "In progress", color: "var(--line-strong)", match: (s: string) => ["DRAFT", "AUTHORIZED", "PROPOSED", "DISPUTED"].includes(s) },
];

export function LedgerGrid() {
  const router = useRouter();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ rows: LedgerRow[] }>("/api/ledger")
        .then((r) => alive && setRows(r.rows))
        .catch((e) => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const stats = useMemo(() => {
    const rs = rows ?? [];
    const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    const blocked = rs.filter((r) => r.status === "VOIDED");
    return {
      count: rs.length,
      captured: sum(rs.filter((r) => r.capturedCents != null && !r.refunded).map((r) => r.capturedCents)),
      blockedCount: blocked.length,
      blockedValue: sum(blocked.map((r) => r.totalCents ?? r.ceilingCents)),
      refunded: sum(rs.filter((r) => r.refunded).map((r) => r.capturedCents)),
      injections: rs.filter((r) => r.failedRules?.includes("R6")).length,
      groups: OUTCOME_GROUPS.map((g) => ({ ...g, n: rs.filter((r) => g.match(r.status)).length })).filter((g) => g.n > 0),
    };
  }, [rows]);

  if (error)
    return (
      <p className="alert error" role="alert">
        {error}
      </p>
    );

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{stats.count}</div>
          <div className="k">Purchases</div>
        </div>
        <div className="kpi">
          <div className="v" style={{ color: "var(--pass)" }}>
            {usd(stats.captured)}
          </div>
          <div className="k">Kept by merchants</div>
        </div>
        <div className="kpi">
          <div className="v" style={{ color: "var(--fail)" }}>
            {usd(stats.blockedValue)}
          </div>
          <div className="k">
            Blocked before payment, {stats.blockedCount} purchase{stats.blockedCount === 1 ? "" : "s"}
          </div>
        </div>
        <div className="kpi">
          <div className="v">{usd(stats.refunded)}</div>
          <div className="k">
            <RotateCcw size={13} aria-hidden /> Refunded by verdict
          </div>
        </div>
        <div className="kpi">
          <div className="v">{stats.injections}</div>
          <div className="k">
            <ShieldX size={13} aria-hidden /> Listings with hidden instructions
          </div>
        </div>
      </div>

      {stats.count > 0 && (
        <div className="outcomes" aria-label="Outcomes">
          <div className="outcome-bar" role="img" aria-label={stats.groups.map((g) => `${g.label}: ${g.n}`).join(", ")}>
            {stats.groups.map((g) => (
              <span key={g.key} style={{ flex: g.n, background: g.color }} title={`${g.label}: ${g.n}`} />
            ))}
          </div>
          <div className="outcome-legend">
            {stats.groups.map((g) => (
              <span key={g.key}>
                <i className="swatch" style={{ background: g.color }} /> {g.label} <b className="num">{g.n}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      {rows && rows.length === 0 ? (
        <div className="panel empty-state" style={{ marginTop: 16 }}>
          <h2>No purchases yet</h2>
          <p style={{ marginTop: 6 }}>Every mandate, firewall decision, PayPal id and verdict will land here.</p>
          <Link className="btn" href="/" style={{ marginTop: 16 }}>
            Make the first purchase
          </Link>
        </div>
      ) : (
        <div className="ledger-grid">
          <AgGridReact<LedgerRow>
            theme={theme}
            rowData={rows ?? []}
            loading={rows === null}
            columnDefs={columns}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            getRowId={(p) => p.data.id}
            onRowClicked={(e) => e.data && router.push(`/run/${e.data.id}`)}
            rowStyle={{ cursor: "pointer" }}
            tooltipShowDelay={300}
            rowHeight={44}
          />
        </div>
      )}
      <div className="row small muted" style={{ marginTop: 12 }}>
        Click a row to open the full case.
        <span className="spacer" />
        <button className="ghost" onClick={() => api("/api/demo/reset-listings", { body: {} }).then(() => router.refresh())}>
          <RotateCcw size={14} aria-hidden /> Undo simulated merchant edits
        </button>
      </div>
    </>
  );
}
