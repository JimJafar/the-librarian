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
// INTENTIONAL DESIGN CHOICE — per-process, in-memory, NOT disk-persisted: the
// cursor lives only for this `opencode` process's lifetime. An `opencode` RESTART
// therefore resets every session's cursor to a fresh start and re-ships the
// visible conversation FROM TURN 0 by design. This is correctness-safe and
// deliberate (we do NOT add disk persistence): idempotency does not depend on the
// cursor surviving a restart, it rests on
//   (1) the curator's FACT-LEVEL dedup (re-shipped turns yield the same facts, so
//       a re-ship produces no duplicate memory), and
//   (2) advance-on-ack, which holds WITHIN a process (the cursor only moves on a
//       server ack, so nothing is dropped or double-counted mid-process).
// The contract `seq` is a NON-AUTHORITATIVE rendered label — the server does NOT
// replay-reject on it — so a restart re-starting `seq` at 1 is harmless. (Disk
// persistence would only help if sessionID were stable across an opencode restart,
// which is e2e-unverifiable here; its benefit is unproven, so we don't pay for it.)
// Keyed by `sessionID` ONLY (never `$USER`/cwd), so N concurrent same-process
// sessions get N distinct cursors (SC5).

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
