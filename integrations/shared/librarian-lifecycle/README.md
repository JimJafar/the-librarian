# @librarian/lifecycle

Shared harness lifecycle helper used by every Librarian integration (Claude
Code, Codex, Hermes, OpenCode, Pi). It is the single place where the rules from
[`docs/specs/harness-commands-and-lifecycle-spec.md`](../../../docs/specs/harness-commands-and-lifecycle-spec.md)
live, so each harness hook stays a thin adapter.

Dependency-light by design (§6) — it runs in several harness environments and
must not drag heavy deps into hook scripts.

## Modules

| Module       | Responsibility (spec)                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `privacy.ts` | Detect privacy markers and the toggle command (§3.1, §3.3). Pure, no I/O.        |
| `state.ts`   | Load/save local harness state; atomic writes, `0700`/`0600`, fail-closed (§4).   |
| `cli.ts`     | Call `the-librarian` with consistent flags (§8).                                 |
| `session.ts` | Idempotent start/resume/pause, checkpoint gating, private-transition end (§5/§9). |

## Privacy detection

```ts
import { detectPrivacySignal } from "@librarian/lifecycle";

detectPrivacySignal("off the record, here's a secret");
// → { signal: "enter-private", matched: "off the record", hasSubstantiveContent: true }
```

Detection is exact / near-exact phrase matching only (§3.3) — never a semantic
classifier. The bias is deliberate: a missed marker leaks nothing on its own,
but a false positive on ordinary prose ("refactor the **private** fields")
would silently stop recording legitimate work. Private markers take precedence
over exit markers in the same prompt (fail toward privacy).
