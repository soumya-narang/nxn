import { resetDbForTests, type DB } from "@/lib/db";
import { getListing, type Listing } from "@/lib/catalog";
import type { MandateRules } from "@/lib/mandate";
import { createMandate, type Mandate } from "@/lib/store";

export function freshDb(): DB {
  return resetDbForTests();
}

export function rules(overrides: Partial<MandateRules> = {}): MandateRules {
  return {
    category: "webcam",
    ceilingCents: 6000,
    currency: "USD",
    maxDeliveryDays: 7,
    allowedSellers: [],
    requiredFeatures: ["USB-C"],
    compatibility: [],
    notes: [],
    summary: "webcam under $60",
    ...overrides,
  };
}

export function mandate(db: DB, r: MandateRules = rules(), scenario: string | null = null, rawIntent = "test intent"): Mandate {
  return createMandate(db, { rawIntent, rules: r, scenario, extractor: "heuristic", warnings: [] });
}

export function listing(db: DB, id: string): Listing {
  const l = getListing(db, id);
  if (!l) throw new Error(`missing listing ${id}`);
  return l;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
