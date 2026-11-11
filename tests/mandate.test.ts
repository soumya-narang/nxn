import { describe, expect, it } from "vitest";
import { extractMandate, extractMandateHeuristic, MandateExtractionError, MandateRules } from "@/lib/mandate";
import { SCENARIOS } from "@/lib/scenarios";

describe("mandate extraction (rule-based fallback)", () => {
  it("parses the README example", () => {
    const { rules } = extractMandateHeuristic("buy me a webcam under $60, USB-C, arriving this week, no subscriptions");
    expect(rules).toMatchObject({
      category: "webcam",
      ceilingCents: 6000,
      maxDeliveryDays: 7,
      requiredFeatures: ["USB-C"],
      compatibility: [],
      allowedSellers: [],
    });
  });

  it("parses all three demo scenario intents", () => {
    const [safe, blocked, slipped] = SCENARIOS.map((s) => extractMandateHeuristic(s.intent).rules);
    expect(safe.category).toBe("webcam");
    expect(blocked.category).toBe("microphone");
    expect(blocked.requiredFeatures).toContain("USB-C");
    expect(slipped.compatibility).toEqual(["macOS"]);
  });

  it("understands other phrasings", () => {
    const { rules } = extractMandateHeuristic("Need wireless noise-cancelling headphones, budget of 85.50, within 5 days, from Larkspur Electronics, for my Linux laptop");
    expect(rules).toMatchObject({
      category: "headphones",
      ceilingCents: 8550,
      maxDeliveryDays: 5,
      allowedSellers: ["sel-larkspur"],
      compatibility: ["Linux"],
    });
    expect(rules.requiredFeatures).toEqual(expect.arrayContaining(["Wireless", "Noise cancelling"]));
  });

  it("refuses requests it cannot turn into a mandate", () => {
    expect(() => extractMandateHeuristic("buy me something nice")).toThrow(MandateExtractionError);
    expect(() => extractMandateHeuristic("a webcam please")).toThrow(/budget/);
    expect(() => extractMandateHeuristic("a toaster under $40")).toThrow(/category/);
  });

  it("caps the budget for the sandbox prototype", () => {
    expect(() => extractMandateHeuristic("a webcam under $5000")).toThrow();
  });

  it("falls back to the parser when no LLM key is set", async () => {
    const r = await extractMandate(SCENARIOS[0].intent);
    expect(r.extractor).toBe("heuristic");
    expect(MandateRules.safeParse(r.rules).success).toBe(true);
  });
});
