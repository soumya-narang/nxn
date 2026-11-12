"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlusCircle, Table2 } from "lucide-react";

export function Nav() {
  const path = usePathname();
  const isLedger = path.startsWith("/ledger");
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" aria-label="New purchase" aria-current={!isLedger ? "page" : undefined}>
        <PlusCircle size={16} aria-hidden /> <span className="nav-text">New purchase</span>
      </Link>
      <Link href="/ledger" aria-label="Audit ledger" aria-current={isLedger ? "page" : undefined}>
        <Table2 size={16} aria-hidden /> <span className="nav-text">Audit ledger</span>
      </Link>
    </nav>
  );
}
