# @librarian/intake-eval

Operator-driven evaluation harness for the intake's `navigate → judge →
route` pipeline (plan 036 Phase 4, the **C6 checkpoint**). It runs a set of
fixtures — a submission plus the existing memories the judge can see — through
the real pipeline with a configured model, and scores the plans against a
ground-truth outcome. Since rethink T8 the pipeline under evaluation uses the
unified curator prompt (`curator-prompt.ts`, v5) in intake mode.

The operator CLI calls a real model, so it is **not** part of the CI test
gate. The package's own unit tests drive the pipeline with a deterministic
scripted model, so `pnpm test` stays offline and fast.

> TODO(rethink §6.4): generalize this package to `curator-eval` — same harness,
> fixtures for the unified prompt's grooming mode too. Descoped from T8 (the
> spec's explicit hatch): the fixture schema, metrics and CLI are intake-shaped,
> so the rename is not the "small mechanical change" the spec budgets for.

## Metrics

| metric                   | scenario | question |
| ------------------------ | -------- | -------- |
| `filing_accuracy`        | all      | right action, and right target when one is named? |
| `decision_band_accuracy` | all      | did confidence route to the right D13 verdict (apply / propose / skip)? |
| `no_clobber_rate`        | S18      | did an edit to a hand-authored doc preserve its prose? |
| `contradiction_recall`   | S4       | was a contradicting update *superseded* (not blindly augmented)? |
| `entity_resolution`      | S12      | did an ambiguous merge AVOID a confident wrong-merge? |

## Fixtures

`fixtures/seed-v1.json` covers S1/S2/S4/S12/S18 with both `straight` and
`boundary` cases. The schema (`src/fixture.ts`) enforces, at load time, that a
targeted action names a corpus doc that exists and that the `action`↔`decision`
pair is one the router can actually produce.

## Running against a real model

```sh
export LIBRARIAN_INTAKE_EVAL_ENDPOINT=https://api.openai.com/v1
export LIBRARIAN_INTAKE_EVAL_TOKEN=sk-...

# print a summary
node dist/cli/bin.js run --model deepseek-v4-flash

# freeze this run as the baseline
node dist/cli/bin.js run --model deepseek-v4-flash --update-baseline fixtures/baseline.json

# gate a later run against the frozen baseline (non-zero exit on regression)
node dist/cli/bin.js run --model deepseek-v4-flash --baseline fixtures/baseline.json --gate
```

## The frozen baseline (operator step)

A meaningful baseline must be produced by an **operator running a real model** —
it can't be generated in CI or from the deterministic fake (which trivially
scores 1.0). Generate it once with `--update-baseline`, commit the resulting
`fixtures/baseline.json`, then wire `--baseline … --gate` into whatever cadence
you want regressions caught at. Until that baseline exists, the gate is inert.
