import { describe, expect, it } from "vitest";
import { appendEvent, getTrace, GENESIS_HASH, snapshotIntact, snapshotListing, verifyChain } from "@/lib/recorder";
import { freshDb, listing, mandate } from "./helpers";

describe("flight recorder", () => {
  it("builds a verifiable hash chain", () => {
    const db = freshDb();
    const m = mandate(db);
    appendEvent(db, m.id, "agent_message", { text: "hello" });
    appendEvent(db, m.id, "tool_call", { tool: "search_catalog", input: { query: "webcam" } });
    const trace = getTrace(db, m.id);
    expect(trace.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(trace[0].prevHash).toBe(GENESIS_HASH);
    expect(trace[1].prevHash).toBe(trace[0].hash);
    expect(verifyChain(trace)).toMatchObject({ ok: true, length: 3 });
  });

  it("keeps separate chains per mandate", () => {
    const db = freshDb();
    const a = mandate(db);
    const b = mandate(db);
    appendEvent(db, a.id, "agent_message", { text: "a" });
    expect(getTrace(db, b.id)).toHaveLength(1);
    expect(verifyChain(getTrace(db, a.id)).ok).toBe(true);
  });

  it("detects an edited payload", () => {
    const db = freshDb();
    const m = mandate(db);
    appendEvent(db, m.id, "agent_message", { text: "I will not buy the Windows-only camera" });
    appendEvent(db, m.id, "agent_message", { text: "done" });
    db.prepare("UPDATE trace_events SET payload_json = ? WHERE mandate_id = ? AND seq = 2").run(JSON.stringify({ text: "edited" }), m.id);
    expect(verifyChain(getTrace(db, m.id))).toMatchObject({ ok: false, brokenAtSeq: 2, reason: "entry hash mismatch" });
  });

  it("detects a deleted entry", () => {
    const db = freshDb();
    const m = mandate(db);
    appendEvent(db, m.id, "agent_message", { text: "1" });
    appendEvent(db, m.id, "agent_message", { text: "2" });
    db.prepare("DELETE FROM trace_events WHERE mandate_id = ? AND seq = 2").run(m.id);
    expect(verifyChain(getTrace(db, m.id)).ok).toBe(false);
  });

  it("snapshots listings with a content hash and logs them", () => {
    const db = freshDb();
    const m = mandate(db);
    const snap = snapshotListing(db, m.id, listing(db, "cam-pixelon-p1"));
    expect(snapshotIntact(snap)).toBe(true);
    expect(snapshotIntact({ ...snap, content: { ...snap.content, compatibility: ["Windows", "macOS"] } })).toBe(false);
    expect(getTrace(db, m.id).at(-1)).toMatchObject({ type: "listing_snapshot", payload: { listingId: "cam-pixelon-p1", hash: snap.hash } });
  });
});
