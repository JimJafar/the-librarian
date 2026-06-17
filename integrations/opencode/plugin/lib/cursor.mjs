// OpenCode auto-capture adapter — the per-session cursor (pure, testable).
// Spec 2026-06-16-harness-auto-capture, Phase 2A (OpenCode).
//
// Unlike the Claude/Codex adapters — short-lived command-hook processes that need
// a DURABLE on-disk byte-offset cursor between firings — an OpenCode plugin is a
// LONG-LIVED module loaded once per `opencode` process. So the cursor is kept
// IN-MEMORY for the plugin's lifetime, keyed by `sessionID`. It records, PER
// SESSION:
//   - `count`   : how many TURNS of the session message list we have already
//                 shipped (or skipped-as-private). The next fire ships the turns
//                 AFTER this index. (A turn count, not a byte offset — OpenCode
//                 hands us a structured message list, not an append-only file.)
//   - `seq`     : the adapter's monotonic delta counter for the contract payload.
//   - `private` : whether the previous fire ended inside an open `[private=on]`
//                 span (carry-forward) — so an unterminated span stays private.
//
// Non-critical state, like the Claude/Codex cursor: if the process restarts the
// in-memory cursor resets to a fresh start and the session re-ships from 0 —
// idempotency then rests on the curator's fact-level dedup + advance-on-ack
// (re-shipping is safe). Keyed by `sessionID` ONLY (never `$USER`/cwd), so N
// concurrent same-process sessions get N distinct cursors (SC5).

/**
 * Create a fresh in-memory cursor store. Each `opencode` process gets one (the
 * plugin entry instantiates it once); tests get a fresh one per case so state
 * never leaks between assertions.
 *
 * @returns {{read:(id:string)=>{count:number,seq:number,private:boolean},
 *            write:(id:string,state:{count:number,seq:number,private:boolean})=>void}}
 */
export function makeCursorStore() {
  /** @type {Map<string,{count:number,seq:number,private:boolean}>} */
  const cursors = new Map();

  return {
    /**
     * Read a session's cursor. A never-seen session reads as a fresh start
     * (`count:0, seq:0, private:false`) — re-shipping is safe, so this never
     * throws.
     */
    read(sessionId) {
      const c = cursors.get(sessionId);
      if (!c) return { count: 0, seq: 0, private: false };
      return {
        count: Number.isInteger(c.count) && c.count >= 0 ? c.count : 0,
        seq: Number.isInteger(c.seq) && c.seq >= 0 ? c.seq : 0,
        private: c.private === true,
      };
    },

    /** Persist a session's cursor (in-memory). */
    write(sessionId, state) {
      cursors.set(sessionId, {
        count: state.count,
        seq: state.seq,
        private: Boolean(state.private),
      });
    },
  };
}
