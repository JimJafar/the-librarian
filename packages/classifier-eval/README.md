# @librarian/classifier-eval

Operator-driven evaluation harness for the memory classifier (spec
§4.6 of `docs/specs/done/023-classifier-implementation-spec.md`). Three surfaces:

- **`runEval`** — runs a classifier against a fixture and returns a
  structured report. Used by the dashboard's `/classifier-eval` page
  and by the `eval run` CLI.
- **`computeSoftAlert`** — pure helper that computes the §4.3
  max-retries rate over a window of `memory.classified` events.
- **`runFixtureGenerator`** — one-shot pipeline that generates the
  public §4.7 fixture via a 3-grader unanimous-vote consensus filter.
  Exposed via `classifier-eval generate-fixture`.

## CLI

```sh
# Run an evaluation against a remote OpenAI-compatible classifier
classifier-eval run --provider remote --model gpt-4o-mini --sample 10

# Generate the §4.7 public consensus fixture (one-shot, ~$5 of API spend)
classifier-eval generate-fixture \
  --config fixtures/graders.example.json \
  --output fixtures/public-v1.json
```

## `generate-fixture` operator runbook

The §4.7 public fixture is built once and refreshed only when the
classifier prompt changes materially. The pipeline:

1. **Generate** ~1500 candidate memories via one strong LLM, prompted
   for a 60/40 straight/boundary mix.
2. **Grade** each candidate via 3 frontier models from different
   families (Claude, GPT, Gemini). The classifier's own v1 prompt is
   what each grader runs — the consensus filter validates that all
   three families would have given the same verdict in production.
3. **Filter** to unanimous-only (drop any candidate where the 3
   graders disagree).
4. **Trim** to the target size preserving the 60/40 ratio. Iterate
   from step 1 if either bucket falls short.

### Prereqs

- Three API keys for three model families (env vars per the config).
- A graders config JSON (see `fixtures/graders.example.json`).

### Run

```sh
# 1. Copy + edit the example config to point at your endpoints
cp packages/classifier-eval/fixtures/graders.example.json my-graders.json
$EDITOR my-graders.json

# 2. Set the token env vars referenced by `token_env`
export ANTHROPIC_API_KEY=…
export OPENAI_API_KEY=…
export GEMINI_API_KEY=…

# 3. Dry-run validates config + env without making API calls
classifier-eval generate-fixture \
  --config my-graders.json \
  --output packages/classifier-eval/fixtures/public-v1.json \
  --dry-run

# 4. Real run — ~5500 LLM calls, ~$5 budget, several minutes wall-clock
classifier-eval generate-fixture \
  --config my-graders.json \
  --output packages/classifier-eval/fixtures/public-v1.json \
  --verbose

# 5. Commit the resulting fixture + update CHANGELOG with the model
#    versions that produced it (provenance per spec §4.7).
```

### Flag reference

| Flag | Default | Purpose |
|---|---|---|
| `--config <path>` | (required) | Graders JSON config |
| `--output <path>` | (required) | Where to write the fixture |
| `--target <n>` | 900 | Total fixture size |
| `--boundary-ratio <f>` | 0.4 | Fraction of total that's boundary |
| `--candidates-per-batch <n>` | 100 | Per generator call |
| `--max-iterations <n>` | 12 | Generator batches before giving up |
| `--max-calls <n>` | 8000 | Hard cap on LLM calls (budget guard) |
| `--dry-run` | off | Validate config + env without calls |
| `--verbose` | off | Per-iteration progress JSON to stderr |

### What can go wrong

- **Boundary survival is < 50%.** Spec ballpark; if you see <30%
  survival the boundaries probably aren't boundary enough — tighten
  the generator prompt or lower `--boundary-ratio` to reflect what
  the field actually produces.
- **A grader endpoint returns malformed JSON consistently.** Any
  parse failure counts as disagreement; check the model id supports
  JSON-mode response_format. The pipeline doesn't retry within a
  single grader call (one shot per candidate per grader).
- **Budget exhausted before targets met.** Raise `--max-calls` or
  raise `--candidates-per-batch` so each generator call goes
  further.
