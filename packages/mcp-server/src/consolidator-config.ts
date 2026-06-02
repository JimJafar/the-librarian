// Consolidator enablement — the LIBRARIAN_CONSOLIDATOR opt-in (default off).
//
// The inbox model (remember → inbox → async consolidation) ships gated, like the
// markdown-backend cutover. Both the http scheduler (whether to start the tick +
// boot-scan) and the `remember` verb (whether to route to the inbox) read this
// single source of truth so they can't drift.

/** True when the consolidator is opted in via `LIBRARIAN_CONSOLIDATOR=on` (or `true`). */
export function isConsolidatorEnabled(): boolean {
  const value = process.env.LIBRARIAN_CONSOLIDATOR;
  return value === "on" || value === "true";
}
