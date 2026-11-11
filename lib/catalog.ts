import catalogData from "@/data/catalog.json";
import type { DB } from "./db";
import { hashObject, nowIso } from "./util";

export type AddOnKind = "accessory" | "protection_plan" | "subscription";

export interface AddOn {
  id: string;
  name: string;
  priceCents: number;
  recurring: "monthly" | "yearly" | null;
  kind: AddOnKind;
}

export interface Listing {
  id: string;
  title: string;
  category: string;
  brand: string;
  seller: { id: string; name: string };
  priceCents: number;
  shippingCents: number;
  deliveryDays: number;
  sponsored: boolean;
  recurring: boolean;
  features: string[];
  compatibility: string[];
  description: string;
  addOns: AddOn[];
}

export interface ListingSummary {
  id: string;
  title: string;
  brand: string;
  category: string;
  seller: string;
  price: string;
  deliveryDays: number;
  sponsored: boolean;
}

interface CatalogFile {
  store: { name: string; note: string; taxRate: number; currency: string };
  categories: string[];
  sellers: { id: string; name: string }[];
  listings: Listing[];
}

const catalog = catalogData as CatalogFile;

export const STORE = catalog.store;
export const CATEGORIES = catalog.categories;
export const SELLERS = catalog.sellers;

/** Current version of a listing: base catalog plus any merchant edits. */
export function getListing(db: DB, id: string): Listing | null {
  const base = catalog.listings.find((l) => l.id === id);
  if (!base) return null;
  const rows = db
    .prepare("SELECT patch_json FROM listing_overrides WHERE listing_id = ? ORDER BY id")
    .all(id) as { patch_json: string }[];
  let listing: Listing = structuredClone(base);
  for (const row of rows) listing = { ...listing, ...(JSON.parse(row.patch_json) as Partial<Listing>) };
  return listing;
}

export function allListings(db: DB): Listing[] {
  return catalog.listings.map((l) => getListing(db, l.id)!);
}

export function listingHash(listing: Listing): string {
  return hashObject(listing);
}

export function summarize(listing: Listing): ListingSummary {
  return {
    id: listing.id,
    title: listing.title,
    brand: listing.brand,
    category: listing.category,
    seller: listing.seller.name,
    price: `$${(listing.priceCents / 100).toFixed(2)}`,
    deliveryDays: listing.deliveryDays,
    sponsored: listing.sponsored,
  };
}

/** Keyword search. Sponsored listings come first, like a real storefront. */
export function searchCatalog(
  db: DB,
  opts: { query: string; category?: string; maxPriceCents?: number },
): ListingSummary[] {
  const words = opts.query
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1);
  const results = allListings(db).filter((l) => {
    if (opts.category && l.category !== opts.category) return false;
    if (opts.maxPriceCents !== undefined && l.priceCents > opts.maxPriceCents) return false;
    if (words.length === 0) return true;
    const hay = `${l.title} ${l.category} ${l.brand} ${l.features.join(" ")}`.toLowerCase();
    return words.some((w) => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
  });
  results.sort((a, b) => Number(b.sponsored) - Number(a.sponsored) || a.priceCents - b.priceCents);
  return results.map(summarize);
}

export interface PriceBreakdown {
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  addOnsCents: number;
  totalCents: number;
  lines: { label: string; cents: number }[];
  unknownAddOns: string[];
}

/** Server-side total. The agent's own arithmetic is never trusted. */
export function computeTotal(listing: Listing, addOnIds: string[]): PriceBreakdown {
  const taxCents = Math.round(listing.priceCents * STORE.taxRate);
  const lines: { label: string; cents: number }[] = [
    { label: listing.title, cents: listing.priceCents },
    { label: "Shipping", cents: listing.shippingCents },
    { label: `Tax (${Math.round(STORE.taxRate * 100)}%)`, cents: taxCents },
  ];
  let addOnsCents = 0;
  const unknownAddOns: string[] = [];
  for (const id of addOnIds) {
    const addOn = listing.addOns.find((a) => a.id === id);
    if (!addOn) {
      unknownAddOns.push(id);
      continue;
    }
    addOnsCents += addOn.priceCents;
    lines.push({ label: addOn.name, cents: addOn.priceCents });
  }
  return {
    itemCents: listing.priceCents,
    shippingCents: listing.shippingCents,
    taxCents,
    addOnsCents,
    totalCents: listing.priceCents + listing.shippingCents + taxCents + addOnsCents,
    lines,
    unknownAddOns,
  };
}

/** Demo-only: the fictional merchant edits a listing (used to show merchant fault). */
export function applyMerchantEdit(db: DB, listingId: string, patch: Partial<Listing>): Listing {
  const base = getListing(db, listingId);
  if (!base) throw new Error(`unknown listing ${listingId}`);
  db.prepare("INSERT INTO listing_overrides (listing_id, patch_json, created_at) VALUES (?, ?, ?)").run(
    listingId,
    JSON.stringify(patch),
    nowIso(),
  );
  return getListing(db, listingId)!;
}
