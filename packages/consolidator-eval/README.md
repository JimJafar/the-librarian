# @librarian/consolidator-eval

Operator-driven evaluation harness for the consolidator's `navigate → judge →
route` pipeline (plan 036 Phase 4, the **C6 checkpoint**). It runs a set of
fixtures — a submission plus the existing memories the judge can see — through
the real pipeline with a configured model, and scores the plans against a
ground-truth outcome.

Like `@librarian/classifier-eval`, this is **not** part of the CI test gate (it
calls a real model). The package's own unit tests drive the pipeline with a
deterministic scripted model, so `pnpm test` stays offline and fast.

## Metrics

| metric                   | scenario | question |
| ------------------------ | -------- | -------- |
| `filing_accuracy`        | all      | right action, and right target when one is named? |
| `decision_band_accuracy` | all      | did confidence route to the right band (auto / propose / create_new / skip)? |
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
export LIBRARIAN_CONSOLIDATOR_EVAL_ENDPOINT=https://api.openai.com/v1
export LIBRARIAN_CONSOLIDATOR_EVAL_TOKEN=sk-...

# print a summary
consolidator-eval run --model gpt-4o-mini

# freeze this run as the baseline
consolidator-eval run --model gpt-4o-mini --update-baseline fixtures/baseline.json

# gate a later run against the frozen baseline (non-zero exit on regression)
consolidator-eval run --model gpt-4o-mini --baseline fixtures/baseline.json --gate
```

## The frozen baseline (operator step)

A meaningful baseline must be produced by an **operator running a real model** —
it can't be generated in CI or from the deterministic fake (which trivially
scores 1.0). Generate it once with `--update-baseline`, commit the resulting
`fixtures/baseline.json`, then wire `--baseline … --gate` into whatever cadence
you want regressions caught at. Until that baseline exists, the gate is inert.
