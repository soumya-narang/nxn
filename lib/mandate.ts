import { z } from "zod";
import { generateText, Output } from "ai";
import { CATEGORIES, SELLERS } from "./catalog";
import { getModel } from "./llm";

/** Hard ceiling for the prototype: sandbox demo purchases only. */
export const MAX_CEILING_CENTS = 100_000;

/**
 * The typed mandate. Hard rules (R1-R7) read from it before capture; the soft
 * fields (features, compatibility, notes) are what the arbiter settles later.
 */
export const MandateRules = z.object({
  category: z.string().refine((c) => CATEGORIES.includes(c), { message: "unknown category" }),
  ceilingCents: z.number().int().positive().max(MAX_CEILING_CENTS),
  currency: z.literal("USD"),
  maxDeliveryDays: z.number().int().positive().max(60).nullable(),
  allowedSellers: z.array(z.string()),
  requiredFeatures: z.array(z.string()),
  compatibility: z.array(z.string()),
  notes: z.array(z.string()),
  summary: z.string().max(300),
});
export type MandateRules = z.infer<typeof MandateRules>;

/** What the LLM fills in. Dollars, not cents: models are bad at unit conversion. */
const ExtractedMandate = z.object({
  category: z.enum(CATEGORIES as [string, ...string[]]).describe("Product category from the store's list"),
  ceilingUsd: z.number().positive().describe("Maximum total the user will pay, in US dollars, including tax and shipping"),
  maxDeliveryDays: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Latest acceptable delivery, in days from today. 'this week' = 7, 'tomorrow' = 1. null if not stated"),
  allowedSellers: z.array(z.string()).describe("Seller ids the user explicitly restricted to; empty if not stated"),
  requiredFeatures: z.array(z.string()).describe("Concrete product features the user asked for, e.g. 'USB-C', '4K', 'Wireless'"),
  compatibility: z
    .array(z.string())
    .describe("Platforms the product must work with, normalised to: Windows, macOS, Linux, ChromeOS. Empty if not stated"),
  notes: z.array(z.string()).describe("Any other preference that cannot be checked mechanically, quoted from the user"),
  summary: z.string().describe("One-sentence restatement of the mandate"),
});

export interface ExtractionResult {
  rules: MandateRules;
  extractor: "llm" | "heuristic";
  warnings: string[];
}

export async function extractMandate(intent: string): Promise<ExtractionResult> {
  const model = getModel();
  if (model) {
    try {
      const { output } = await generateText({
        model,
        maxRetries: 1,
        timeout: 20_000,
        output: Output.object({ schema: ExtractedMandate }),
        system:
          "You convert a shopper's request into a structured purchase mandate. Extract only what the user said. " +
          "Never invent constraints. The ceiling is a total budget in USD. " +
          `Store categories: ${CATEGORIES.join(", ")}. Sellers: ${SELLERS.map((s) => `${s.id} (${s.name})`).join(", ")}.`,
        prompt: intent,
      });
      const rules = MandateRules.parse({
        category: output.category,
        ceilingCents: Math.round(output.ceilingUsd * 100),
        currency: "USD",
        maxDeliveryDays: output.maxDeliveryDays,
        allowedSellers: output.allowedSellers.filter((s) => SELLERS.some((x) => x.id === s)),
        requiredFeatures: dedupe(output.requiredFeatures.map(normaliseFeature)),
        compatibility: dedupe(output.compatibility.map(normalisePlatform).filter(Boolean) as string[]),
        notes: output.notes,
        summary: output.summary.slice(0, 300),
      });
      return { rules, extractor: "llm", warnings: [] };
    } catch (err) {
      const heuristic = extractMandateHeuristic(intent);
      heuristic.warnings.unshift(`LLM extraction failed, used the rule-based parser instead (${shortError(err)})`);
      return heuristic;
    }
  }
  return extractMandateHeuristic(intent);
}

const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(web ?cams?|cameras?)\b/i, "webcam"],
  [/\b(microphones?|mics?)\b/i, "microphone"],
  [/\b(headphones?|headsets?|earbuds|earphones)\b/i, "headphones"],
];

const FEATURE_WORDS: [RegExp, string][] = [
  [/\busb[- ]?c\b/i, "USB-C"],
  [/\busb[- ]?a\b/i, "USB-A"],
  [/\b4k\b/i, "4K"],
  [/\b1080p\b/i, "1080p"],
  [/\bwireless|bluetooth\b/i, "Wireless"],
  [/\bnoise[- ]cancel+ing\b/i, "Noise cancelling"],
  [/\bprivacy shutter\b/i, "Privacy shutter"],
];

const PLATFORM_WORDS: [RegExp, string][] = [
  [/\b(mac|macs|macbook\w*|imac|macos|os x)\b/i, "macOS"],
  [/\bwindows\b/i, "Windows"],
  [/\blinux|ubuntu\b/i, "Linux"],
  [/\bchromebook|chromeos\b/i, "ChromeOS"],
];

/** Rule-based fallback used when no LLM is configured or the LLM call fails. */
export function extractMandateHeuristic(intent: string): ExtractionResult {
  const warnings: string[] = [];
  const text = intent.trim();

  const category = CATEGORY_WORDS.find(([re]) => re.test(text))?.[1];
  const money =
    text.match(/(?:under|below|less than|max(?:imum)?|up to|at most|no more than|budget(?: of)?|<)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ??
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);

  let maxDeliveryDays: number | null = null;
  const within = text.match(/(?:within|in|under)\s+(\d{1,2})\s+days?/i);
  if (within) maxDeliveryDays = Number(within[1]);
  else if (/\b(today|tomorrow)\b/i.test(text)) maxDeliveryDays = 1;
  else if (/\bthis week\b/i.test(text)) maxDeliveryDays = 7;
  else if (/\bnext week\b/i.test(text)) maxDeliveryDays = 14;

  if (!category) warnings.push(`Could not find a product category. Store categories: ${CATEGORIES.join(", ")}.`);
  if (!money) warnings.push("Could not find a budget. Say e.g. 'under $60'.");

  const rules = {
    category: category ?? "",
    ceilingCents: money ? Math.round(Number(money[1]) * 100) : 0,
    currency: "USD" as const,
    maxDeliveryDays,
    allowedSellers: SELLERS.filter((s) => new RegExp(`\\b${escapeRe(s.name)}\\b`, "i").test(text)).map((s) => s.id),
    requiredFeatures: FEATURE_WORDS.filter(([re]) => re.test(text)).map(([, f]) => f),
    compatibility: PLATFORM_WORDS.filter(([re]) => re.test(text)).map(([, p]) => p),
    notes: [] as string[],
    summary: text.slice(0, 300),
  };

  const parsed = MandateRules.safeParse(rules);
  if (!parsed.success) {
    throw new MandateExtractionError(warnings.length ? warnings : parsed.error.issues.map((i) => i.message));
  }
  return { rules: parsed.data, extractor: "heuristic", warnings };
}

export class MandateExtractionError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" "));
  }
}

export function normalisePlatform(p: string): string | null {
  return PLATFORM_WORDS.find(([re]) => re.test(p))?.[1] ?? null;
}

export function normaliseFeature(f: string): string {
  return FEATURE_WORDS.find(([re]) => re.test(f))?.[1] ?? f.trim();
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? msg.slice(0, 157) + "..." : msg;
}
