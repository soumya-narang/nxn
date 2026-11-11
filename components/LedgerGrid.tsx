"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, colorSchemeVariable, themeQuartz, type ColDef } from "ag-grid-community";
import type { LedgerRow } from "@/lib/view";
import { api } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withPart(colorSchemeVariable).withParams({ fontSize: 13, headerFontWeight: 600 });

const statusStyle = (status: string | null) => {
  if (!status) return undefined;
  if (status === "VOIDED" || status === "AGENT" || status === "MERCHANT") return { color: "var(--fail)", fontWeight: 600 };
  if (status === "CAPTURED" || status.startsWith("SETTLED")) return { color: "var(--pass)", fontWeight: 600 };
  if (status === "MANUAL_REVIEW" || status === "UNDETERMINED" || status === "USER") return { color: "var(--warn)", fontWeight: 600 };
  return undefined;
};

const mono = { fontFamily: "var(--mono)", fontSize: 12 };

const columns: ColDef<LedgerRow>[] = [
  { field: "createdAt", headerName: "Created", width: 170, sort: "desc", valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : "") },
  { field: "id", headerName: "Mandate", width: 150, cellStyle: mono },
  { field: "intent", headerName: "Intent", flex: 2, minWidth: 260, tooltipField: "intent" },
  { field: "status", headerName: "Status", width: 160, cellStyle: (p) => statusStyle(p.value) ?? null },
  { field: "ceiling", headerName: "Hold", width: 90 },
  { field: "total", headerName: "Total", width: 90 },
  { field: "captured", headerName: "Captured", width: 100 },
  { field: "failedRules", headerName: "Failed rules", width: 150 },
  { field: "fault", headerName: "Fault", width: 120, cellStyle: (p) => statusStyle(p.value) ?? null },
  { field: "confidence", headerName: "Conf.", width: 80 },
  { field: "orderId", headerName: "PayPal order", width: 190, cellStyle: mono },
  { field: "authorizationId", headerName: "Authorization", width: 190, cellStyle: mono },
  { field: "captureId", headerName: "Capture", width: 190, cellStyle: mono },
  { field: "refundId", headerName: "Refund", width: 190, cellStyle: mono },
  { field: "payoutId", headerName: "Bond payout", width: 200, cellStyle: mono },
  { field: "webhooks", headerName: "Webhooks", width: 260, tooltipField: "webhooks" },
  { field: "chainOk", headerName: "Chain", width: 90, valueFormatter: (p) => (p.value ? "intact" : "BROKEN") },
  { field: "scenario", headerName: "Scenario", width: 110 },
];

export function LedgerGrid() {
  const router = useRouter();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => (document.body.dataset.agThemeMode = mq.matches ? "dark" : "light");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

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

  if (error) return <p className="error">{error}</p>;
  return (
    <>
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
          overlayNoRowsTemplate="No mandates yet. Create one on the New mandate page."
          tooltipShowDelay={300}
        />
      </div>
      <p className="row muted small">
        Click a row to open its run page.
        <span className="spacer" />
        <button className="ghost" onClick={() => api("/api/demo/reset-listings", { body: {} }).then(() => router.refresh())}>
          Undo simulated merchant edits
        </button>
      </p>
    </>
  );
}
