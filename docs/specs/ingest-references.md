# Working doc — Reference ingest (extension + mobile share + server endpoint)

Status: **brainstorm / explore-change**. Not a spec yet. Decisions (Dn) are
binding once confirmed; hypotheses (Hn) are still open.

## The question

Let users add new **references** to their Librarian vault from outside an agent
session — starting with a Chromium browser extension and an iOS/Android
share-to path, backed by a server-side ingest endpoint that accepts a URL /
text / (later) a document and does the right thing with each.

## Owner's framing (Jim, verbatim intent)

- Small Chromium extension (Chrome + Edge). Click it → extract the *article*
  (strip nav/ads/chrome) → POST to the user's Librarian server. User configures
  the extension with their server URL.
- iOS/Android "share to Librarian". iOS via a self-built share-sheet target
  that POSTs to a URL, distributed as a link users install themselves.
- Realisation: mobile share usually only hands over a **URL**. So the real
  keystone is a **server-side ingest endpoint** that accepts URL | text |
  document and dispatches:
  - **URL** → server fetches the page, extracts, converts to markdown, writes
    frontmatter, saves to vault.
  - **text** → write straight to a markdown reference.
  - **document** → phase 2.

## Audit (frozen — from code, file:line)

- **References** = plain markdown in `vault/references/`, **no required
  frontmatter**, file-path *is* the ID. Chunked lazily at search time, not on
  write. `packages/core/src/store/corpus-index.ts:38-40,149-200`,
  `store/index/reference-chunker.ts:23-72`.
- **No write path for references over the wire today.** Only `search_references`
  (read) exists on `/mcp`. References are written via dashboard tRPC
  `vault.write`/`vault.create` (admin, internal socket) or hand-edit. References
  are currently **admin-curated by design** — this feature is a deliberate
  widening. `mcp/tools/search-references.ts:25-33`.
- **Every vault write = a git commit** (`store/corpus/vault.ts:95-99`). No
  staging state.
- **HTTP surface** = Node native `http`, two listeners (ADR 0008 P1):
  - **Public** (published port): `GET /healthz`, `GET /primer.md` (unauth),
    `POST /mcp` (Bearer), `POST /transcript` (Bearer). Else 404.
  - **Internal** (unpublished socket): `/trpc/*`, admin by socket isolation, no
    bearer. `packages/mcp-server/src/http/routes.ts:36-37,142-162`.
- **Auth** = Bearer on public surface, always `role: "agent"`. Tokens from
  `LIBRARIAN_AGENT_TOKEN`, `LIBRARIAN_AGENT_TOKENS` map, or dashboard-minted DB
  tokens (`verifyDbToken`). Timing-safe compare. **Single-tenant, single vault
  per server.** `http/auth.ts:64-82,153-158`.
- **No fetch/extraction code or deps exist** (no readability/turndown/defuddle).
  `AGENTS.md:137-139` documents a `redirect: "error"` outbound convention that
  is **not yet implemented** — this feature would be first to need it.
- **Closest existing pattern** = `POST /transcript` fail-soft text intake:
  validate strictly, redact, never throw, teaching errors in body.
  `http/transcript-intake.ts:16-30,104-110`.
- **7 MCP verbs are pinned** by tool-registry + drift-guard tests and mirrored
  verbatim in Hermes/Pi adapters; adding an 8th is a cross-surface change.

## Reframing

The browser extension and the mobile share are **thin clients**. The real
artifact is the **server ingest endpoint** — and the keystone decision is
*where extraction happens*, because that determines whether the endpoint is a
dumb sink, a smart fetcher, or both.

Jim's own description already implies **both**: the extension extracts
client-side ("it would extract the interesting content"), but mobile sends a
bare URL the server must fetch. So the endpoint must accept *either*
pre-extracted markdown *or* a bare URL.

## Open questions — all resolved

- OQ1 → D1 (hybrid). OQ2 → D2 (capture token). OQ3 → D3 (REST endpoint).
  OQ4 → D4 (Shortcuts). OQ5 → D5/D6/D8/D7/D13 (direct/overwrite/layout/async/
  frontmatter). OQ6 → D10 (SSRF guard).
- Sole spec-time validation: does Defuddle run both in-browser and server-side
  under Node (the one shared extraction engine assumption)?

## Hypotheses

- H1 — Endpoint accepts a typed body (`{ url }` | `{ text }` | later `{ file }`)
  — explicit `type`/fields, not content sniffing.
- H2 — New public REST endpoint (e.g. `POST /ingest` or `POST /references`),
  Bearer agent auth, leaves the 7 MCP verbs untouched.
- H3 — Hybrid extraction (OQ1 = yes).
- H4 — iOS/Android via Shortcuts-class tooling, not a compiled share extension.

## Decisions

- **D1 — Hybrid extraction.** The endpoint accepts *either* pre-extracted
  markdown (browser extension, from the live DOM) *or* a bare URL (mobile) that
  the server fetches and extracts. Each client does what it's best at; the
  discriminator is simply whether extracted content is present in the body.
  _2026-06-28._
- **D2 — Dedicated capture token.** External clients authenticate with a
  separate, narrowly-scoped "capture" token (dashboard-minted) that permits
  *only* ingest — not the full agent surface. Least-privilege blast radius for a
  token pasted into a browser extension. Net-new: a capture role/scope in
  `http/auth.ts` (today auth only ever returns `role: "agent"`). _2026-06-28._
- **D3 — New public REST endpoint.** Ingest lives at a new public-listener
  endpoint (e.g. `POST /ingest`), Bearer auth, beside `/mcp` and `/transcript`.
  The sacred 7 MCP verbs and their drift-guard/Hermes/Pi mirrors are untouched.
  _2026-06-28._
- **D4 — Shortcuts-class mobile, link-distributed.** iOS Shortcut (share-sheet
  integrated, iCloud-link distributable) + an Android HTTP-Shortcuts/share-target
  equivalent. No app store, no provisioning. _2026-06-28._ _(See D16/D17 for how
  the iCloud link is authored once and distributed via the dashboard.)_
- **D5 — Direct to `references/`.** Captured content is written straight to the
  searchable corpus, no review gate. The capturer is the curator on a single-user
  self-hosted vault; junk is deleted later via the dashboard. _2026-06-28._
- **D6 — Overwrite in place on re-capture.** Same URL → same deterministic
  filename → re-capture overwrites and refreshes content. Git history (every
  write commits) preserves prior versions. Idempotent, no clutter. _2026-06-28._
- **D7 — Async 202 + visible failures.** Endpoint returns 202 immediately and
  processes in the background (matching `/transcript`). An **ingest log** records
  every attempt (source, timestamp, status, error, resulting path); the dashboard
  surfaces failures so the user can revisit the URL and extract manually. The
  client shows "Queued ✓", not the saved path. _2026-06-28._
- **D8 — `references/web/<date>-<slug>.md` layout.** Title-derived slug,
  date-prefixed, under a `web/` subfolder that separates captured refs from
  hand-curated ones. Readable, sortable, collision-resistant; the slug is the
  deterministic key D6 keys on. _2026-06-28._

## Parking lot

- Document/file ingest (PDF, etc.) — explicit phase 2.
- Auto-tagging / curator enrichment of ingested references.

## Late observations

- **D6 ↔ D8 contradiction (resolved by H5).** A date-prefixed filename breaks
  "same URL overwrites the same file" on a later-day re-capture. Resolution: the
  D7 ingest log doubles as a **URL → path dedup index**. Re-capture looks up the
  URL, overwrites the existing path (original date prefix preserved); unseen URLs
  mint `web/<today>-<slug>.md`. Different URLs colliding on the same day-slug get
  a short URL-hash suffix.
- **Prior art — Obsidian Web Clipper.** This exact feature (browser extension →
  article extraction → markdown + frontmatter) has a strong open-source reference
  implementation in Obsidian Web Clipper, whose extraction engine is **Defuddle**
  (and this environment already has an `obsidian:defuddle` skill). Defuddle is the
  leading candidate for *both* the extension's client-side extraction and the
  server's URL-fetch path — one conceptual engine, two call sites. Validate at
  spec time that it runs both in-browser and server-side under Node.

## Decisions (cont.)

- **D9 — Ingest log in the dashboard DB.** Capture attempts (source, timestamp,
  status, error, resulting path) live in the existing token DB, not the git vault
  — operational state shouldn't commit. Doubles as the D6/H5 URL→path dedup index;
  the dashboard reads it to surface failures (D7). _2026-06-28._
- **D10 — SSRF guard on server fetch.** Block loopback/private/link-local IPs and
  the cloud metadata endpoint; set `redirect: "error"` (or validate each hop) —
  the first code to implement the AGENTS.md outbound convention. _2026-06-28._
- **D11 — Dedup index = ingest log (was H5).** _2026-06-28._
- **D12 — Field-presence request contract (was H6).** Single typed body;
  discriminator is which field is present: `content` (pre-extracted markdown) →
  write as-is; `url` only → server fetches + extracts; `text` only → write as a
  note. Carries source metadata (`url`, `title`, `via`). _2026-06-28._
- **D13 — Additive ingested frontmatter (was H7).** `title`, `source`,
  `captured_at`, `via` (`extension|ios|android`), plus `site`/`byline` when
  extractable. References still carry no *required* frontmatter; search chunks the
  body regardless. _2026-06-28._

## Blind-review corrections (2026-06-28)

A cold adversarial review verified the spec against code and corrected two audit
claims + surfaced blocking issues. Audit corrections:

- **`/transcript` is synchronous 200, not async 202** (`transcript-intake.ts:163,
  178,248`). The async-202 framing was wrong; see D22 for how `/ingest` actually
  splits sync vs background.
- **There is no SQLite "dashboard DB."** Tokens are rows in a JSON **settings
  sidecar** (`createJsonSettingsStore`, `agent-tokens.ts:11-12,76`). D9's "DB"
  wording is corrected by D24 — the ingest log lives in that same sidecar.

New decisions from the review:

- **D18 — Allow http, warn loudly (transport).** `/ingest` accepts plain http
  (localhost/LAN self-host); the "Connect a device" page shows a prominent
  warning and the extension documents the secure-context/mixed-content limitation
  (a Chromium extension cannot `fetch()` http from its secure context, so the
  extension effectively needs https or a localhost target; mobile Shortcuts have
  no such rule). _2026-06-28._
- **D19 — Per-token daily quota + burst cap.** Each capture token gets ~200
  captures/day + ~1/sec burst (counter in the settings store). Bounds the
  repo-bloat + fetch-amplification blast radius of a leaked token. _2026-06-28._
- **D20 — Normalized dedup key.** `lookupByUrl` keys on a normalized URL: strip
  `#fragment`, drop tracking params (`utm_*`, `fbclid`, `gclid`, …), lowercase
  host, strip trailing slash. Same article from different sources dedups to one
  file. _2026-06-28._
- **D21 — Capture scope is a first-class token field, enforced both ways.**
  Supersedes the "small task" framing in D2: add `scope` to the token record,
  surface it from `verifyAgentToken` and `AuthResult`, and **actively reject**
  capture tokens on `/mcp` and agent tokens on `/ingest` (403). The settings-store
  namespace alone gives NO isolation. _2026-06-28._
- **D22 — Sync/async boundary.** Synchronous, before the 202: auth+scope (401/
  403), request-body size cap (413), field-presence validation (400), and writing
  a **`pending`** ingest-log row. Background, after the 202: fetch, extract, write,
  commit, transition the log row to success/failed. Post-202 failures (incl.
  extracted-markdown over-cap) are **logged, never returned**. _2026-06-28._
- **D23 — SSRF by resolved-IP, per hop.** Not `redirect:"error"` (breaks the
  ubiquitous http→https / canonical redirects of the mobile path) and not hostname
  strings (DNS-rebinding TOCTOU). Resolve the host, validate every resolved IP
  against the deny-list (loopback/private/link-local/metadata, **incl. IPv6
  `::1`/`fc00::/7`/`fe80::/10`/IPv4-mapped and decimal/hex encodings**), follow
  redirects manually re-validating each hop, pin the socket to the validated IP,
  cap the **fetched response body** size, and require `Content-Type: text/html`.
  _2026-06-28._
- **D24 — Ingest log in the settings sidecar.** Corrects D9: the log + dedup index
  are rows in the JSON settings store, not a relational DB. _2026-06-28._
- **D25 — Redact secrets in the log.** Run `redactSecrets` (core, used at
  `transcript-intake.ts:131`) over the stored `error` and `source` before
  persisting/rendering — a fetch error or `user:pass@host` URL must not leak.
  _2026-06-28._

## SPIKE-A results (2026-06-28) — both halves favourable

Server-side, empirically verified (`/tmp/defuddle-spike`, defuddle 0.19.1):
- `defuddle/node` accepts an HTML **string**, parses with **linkedom** (light, not
  jsdom), and with `{ markdown: true }` returns clean markdown in `content`
  (`##` headings, `[](…)` links, images, no `<div>`).
- Returns rich metadata free: `title, author, site, published, description,
  domain, image, language, wordCount` → populates the entire D13 frontmatter set.
- ~21 MB install (defuddle 3 MB); parseTime ~1.4 s on a 1 MB / 17k-word page
  (worst case) — fine for background processing. **OQ-A resolved: keep Defuddle on
  both sides; no readability+turndown fallback.**

Browser-side, documented-confirmed (Chrome Extensions API docs via Context7) +
established-behaviour (not load-tested in this sandbox):
- MV3 `optional_host_permissions` + `chrome.permissions.request({origins})` in a
  user gesture grants access to the user-configured server origin at runtime;
  `host_permissions` may include `http://*/*`.
- Mixed-content blocking hits a **content-script** fetch (page origin) but not a
  **background service-worker** fetch to a permitted http origin. **OQ-C resolved:
  the extension CAN reach an http LAN/localhost server — D18 stands, not
  re-opened — provided D26's architecture.**

- **D26 — Extension network architecture.** The content script only *extracts*
  (Defuddle on the live DOM) and messages the result to the **background service
  worker**, which performs the `POST` (sidestepping content-script mixed-content
  blocking). The user's server origin is granted via `optional_host_permissions` +
  a runtime `chrome.permissions.request()` on options-save. _2026-06-28._

**SPIKE-B remains open** — manual, Jim's to run (needs an iPhone + Shortcuts app).

- **D27 — Extension lives in-tree at `clients/chromium-extension`, NOT a separate
  repo.** Per rethink D14 (integrations live in-tree; standalone repos archived)
  and so a server-side `/ingest` contract change ships with its client in one PR.
  A new top-level `clients/` root holds human-facing capture clients;
  `chromium-extension` (Chrome + Edge share Chromium) leaves room for a future
  `clients/firefox-extension`. It's a workspace with its own bundler. _2026-06-28._
- **D28 — Phased, decoupled distribution.** v1 ships as a load-unpacked /
  GitHub-release `.zip` for self-hosters — no store account, no review, no block on
  the feature (mirrors the sideloaded iOS Shortcut). v2 publishes to the Chrome Web
  Store (one-time $5 dev account) + Edge Add-ons (free), gated on a privacy policy +
  data-use disclosures (the extension transmits page content) and minimal
  permissions. **Store publishing is a separate, human-triggered workflow,
  decoupled from the monorepo's merge-cuts-a-release auto-tag** (store review takes
  days; you can't submit on every PATCH). Off-store `.crx` auto-update is dead for
  consumers, so the stores are the only frictionless path — but a v2 follow-up, not
  a blocker. `/ingest` accepts any `chrome-extension://` origin (the capture token
  is the gate, not the origin), so the differing store-vs-unpacked extension IDs
  don't matter. _2026-06-28._

- **D29 — One release when the whole feature ships, not per task.** Building
  task-by-task would auto-cut ~10 GitHub releases of inert scaffolding (a capture
  token + a 202 `/ingest` stub are *releasable* but not *announce-worthy*). So all
  tasks land on a single `feat/reference-ingest` branch; the version bump + the
  single dated CHANGELOG entry are deferred to the **merge-to-main**, which is the
  one release (the auto-tag fires only on that merge). Deliberately bends the
  "every PR is a release" house rule for this multi-task feature; cost is a
  longer-lived branch (rebase onto main if a parallel session ships). _2026-06-28._

## Scenario walks

- **S1 — New user, extension, happy path.** Configure URL + capture token → click
  on an article → extension extracts (Defuddle) `{url,title,content}` → POST →
  auth OK (capture scope) → `content` present, skip fetch → write
  `references/web/2026-06-28-slug.md` + frontmatter → commit → log success → 202
  "Queued ✓". Searchable immediately. **Verdict: clean.**
- **S2 — Mobile share, URL only.** Safari share → Shortcut POSTs `{url}` → server
  background-fetches anonymously, extracts, writes, logs. **Verdict:
  works-with-notes** — the server fetches *logged-out*, so paywalled/personalized
  pages extract poorly or fail; D7's dashboard-surfaced failure + manual revisit
  is the safety net. Inherent to the URL-only path; document it.
- **S3 — Power user re-captures an updated article.** Same URL → log lookup finds
  `web/2026-06-21-slug.md` → overwrite content, refresh `captured_at`, keep the
  original path even if the title (slug) changed. Git diff shows the update.
  **Verdict: clean.**
- **S4 — Failure modes.** Bad token → 401, no write. Malformed body (no
  url/content/text) → 400 teaching error. SSRF target → refused by D10, logged.
  Fetch timeout/403 → logged failure, dashboard surfaces. Server unreachable →
  the client's POST fails; client shows "couldn't reach Librarian." **Verdict:
  clean**, given the gaps below are closed.
- **S5 — Text-only capture.** `{text}` with no URL/title → write a note. **Gap G2**
  — needs a title rule (first non-empty line, truncated; fallback "Captured note
  <date>") and no dedup key (always new file). Resolved by D15.

### Gaps found → resolved

- **G1 — No size cap.** Resolve **D14**: cap request body (~2 MB) and extracted
  markdown (~1 MB); over-limit → 413 teaching error, logged. Mirrors `/transcript`
  validation discipline.
- **G2 — Untitled text has no slug.** Resolve **D15**: slug from the first
  non-empty line (truncated); fallback `note-<date>`. Text captures never dedup
  (no URL key) → always a new file.

## Decisions (final)

- **D14 — Size caps + 413.** _2026-06-28._
- **D15 — Text title/slug derivation.** _2026-06-28._
- **D16 — iCloud Shortcut link is a single author-authored constant, displayed
  (not generated) by the dashboard.** Apple mints iCloud Shortcut links only via
  the Shortcuts app's manual Share → Copy iCloud Link — there is no API and no
  per-user generation. Jim authors the shortcut once and shares it; the resulting
  `https://www.icloud.com/shortcuts/<uuid>` URL is a config constant. The
  dashboard renders it (plus a QR code) but cannot produce it. Updating the
  shortcut's logic uses Apple's "Update Shared Shortcut" to refresh content at a
  stable URL. _(Spec-time: confirm the no-API / manual-share behavior still
  holds; long-standing but worth a check.)_ _2026-06-28._
- **D17 — Per-user config via Import Questions + dashboard-minted token, never in
  the link.** The shared shortcut carries NO secrets. Server URL and capture token
  are entered locally at install time via Shortcuts "Import Questions." The
  dashboard's "Connect a device" page mints the capture token (D2), shows it plus
  the server URL to paste, and renders the iCloud link + QR. Same page serves the
  browser extension (server URL + token) and the Android recipe. _2026-06-28._
