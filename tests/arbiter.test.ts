import { describe, expect, it } from "vitest";
import { arbitrate, type ArbiterInput } from "@/lib/arbiter";
import { applyMerchantEdit, getListing } from "@/lib/catalog";
import { appendEvent, getTrace, snapshotListing, verifyChain } from "@/lib/recorder";
import { freshDb, listing, mandate, rules } from "./helpers";

function setup(listingId: string, r = rules(), rawIntent = "test") {
  const db = freshDb();
  const m = mandate(db, r, null, rawIntent);
  const snapshot = snapshotListing(db, m.id, listing(db, listingId));
  const base = (complaint: string): ArbiterInput => ({
    rawIntent,
    rules: r,
    complaint,
    chain: verifyChain(getTrace(db, m.id)),
    snapshot,
    currentListing: getListing(db, listingId),
  });
  return { db, m, snapshot, base };
}

describe("arbiter", () => {
  it("AGENT fault: snapshot said Windows only, mandate said MacBook", async () => {
    const intent = "Buy me a webcam under $60 that works with my MacBook, USB-C, arriving this week";
    const { base } = setup("cam-pixelon-p1", rules({ compatibility: ["macOS"] }), intent);
    const v = await arbitrate(base("It doesn't work with my MacBook."));
    expect(v.fault).toBe("AGENT");
    expect(v.method).toBe("mechanical");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
    const texts = v.evidence.map((e) => e.text);
    // Quotes the listing line and the mandate line.
    expect(texts).toContain("Windows only: the Pixelon Studio driver is required and is not available for macOS or Linux.");
    expect(texts.some((t) => t.includes("MacBook"))).toBe(true);
    expect(texts).toContain("Mandate rule: must work with macOS");
  });

  it("MERCHANT fault: listing edited after purchase", async () => {
    const { db, base } = setup("cam-clearview-c2");
    applyMerchantEdit(db, "cam-clearview-c2", { features: ["USB-A", "1080p"] });
    const v = await arbitrate({ ...base("It came with a USB-A cable, not USB-C."), currentListing: getListing(db, "cam-clearview-c2") });
    expect(v.fault).toBe("MERCHANT");
    expect(v.evidence.some((e) => e.source === "snapshot" && e.text.includes("USB-C"))).toBe(true);
    expect(v.evidence.some((e) => e.source === "current_listing" && e.text.includes("USB-A"))).toBe(true);
  });

  it("USER responsibility: complaint about a constraint never stated", async () => {
    const { base } = setup("cam-pixelon-p1", rules({ compatibility: [] }), "Buy me a webcam under $60, USB-C, arriving this week");
    const v = await arbitrate(base("It doesn't work with my Mac."));
    expect(v.fault).toBe("USER");
    expect(v.reasoning).toMatch(/never stated/);
  });

  it("goes to manual review when only free text could decide and no LLM is configured", async () => {
    const { base } = setup("cam-clearview-c2", rules({ notes: ["looks good on a bookshelf"] }));
    const v = await arbitrate(base("It's ugly."));
    expect(v.fault).toBeNull();
    expect(v.confidence).toBe(0);
  });

  it("refuses to judge when the flight recorder was tampered with", async () => {
    const { db, m, base } = setup("cam-pixelon-p1", rules({ compatibility: ["macOS"] }));
    appendEvent(db, m.id, "agent_message", { text: "original" });
    db.prepare("UPDATE trace_events SET payload_json = '{}' WHERE mandate_id = ? AND seq = 1").run(m.id);
    const v = await arbitrate({ ...base("doesn't work on Mac"), chain: verifyChain(getTrace(db, m.id)) });
    expect(v.fault).toBeNull();
    expect(v.reasoning).toMatch(/chain is broken/);
  });

  it("refuses to judge on a tampered snapshot", async () => {
    const { base, snapshot } = setup("cam-pixelon-p1", rules({ compatibility: ["macOS"] }));
    const tampered = { ...snapshot, content: { ...snapshot.content, compatibility: ["Windows", "macOS"] } };
    const v = await arbitrate({ ...base("doesn't work on Mac"), snapshot: tampered });
    expect(v.fault).toBeNull();
  });
});
