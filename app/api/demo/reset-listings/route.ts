import { handle } from "@/lib/http";
import { services } from "@/lib/services";

export const dynamic = "force-dynamic";

/** POST (demo only): undo simulated merchant edits so the store matches catalog.json again. */
export const POST = handle(async () => {
  const info = services().db.prepare("DELETE FROM listing_overrides").run();
  return { removedEdits: info.changes };
});
