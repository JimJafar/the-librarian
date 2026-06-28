# Spec — Reference ingest (browser extension + mobile share + `/ingest`)

Source design: [`ingest-references.md`](./ingest-references.md) — decisions
**D1–D25** are binding (D18–D25 added after a blind review). This spec pins
*done* and orders the build; it does not re-open decisions.

> **Revision note.** A cold adversarial review corrected two audit claims and
> found five blocking issues, now folded in. Corrected: `/transcript` is
> **synchronous 200**, not async 202 (`transcript-intake.ts:163,178`); there is
> **no SQLite DB** — tokens + the ingest log live in a JSON **settings sidecar**
> (`agent-tokens.ts:11-12,76`).

## Objective

Let a Librarian user add **references** to their vault from outside an agent
session: a Chromium browser extension and an iOS/Android share-sheet recipe, both
posting to a new `/ingest` endpoint that turns a URL / pre-extracted content / raw
text into a markdown reference. The endpoint is the keystone; the clients are thin.

## De-risk first (two spikes, before build slices)

- **SPIKE-A — Defuddle dual-runtime. ✅ RESOLVED (2026-06-28).** Server-side
  empirically verified: `defuddle/node` (linkedom-based, not jsdom; ~21 MB install)
  takes an HTML string and with `{markdown:true}` returns clean markdown plus full
  D13 metadata; ~1.4 s worst-case parse. Keep Defuddle both sides — no
  readability+turndown fallback (closes OQ-A). Browser-side: MV3 reaches an http
  LAN/localhost server **iff** the POST is done from the **background service
  worker** (not the content script) with the server origin granted via
  `optional_host_permissions` + runtime `chrome.permissions.request()` (D26; closes
  OQ-C, D18 stands). Documented-confirmed; the live load-unpacked check is Task 7's
  acceptance.
- **SPIKE-B — iCloud Shortcut distribution (manual, Jim).** Author a trivial
  shortcut with **Import Questions** for two values, Share → Copy iCloud Link,
  install on a *fresh* device, confirm: install prompts for the values, no
  programmatic minting API exists, "Update Shared Shortcut" refreshes content at a
  stable URL. Output: confirmation note + sample link + import-question screenshots.

Neither spike writes production code. SPIKE-A blocks Tasks 6–7; SPIKE-B blocks
Task 8 (and Task 9's link rendering).

## The request/response contract (pin this — clients depend on it)

- **Method/path:** `POST /ingest` on the public listener. `chrome-extension://`
  origins must pass the `isAllowedOrigin` gate (`routes.ts:136`) — add them to the
  allow-list / bypass for this route, else the browser POST 403s before dispatch.
- **Auth:** `Authorization: Bearer <capture-token>` required. Capture scope only
  (see Auth criteria). http is **allowed** (D18) — no TLS requirement at the
  endpoint — but see the extension caveat in SPIKE-A/Task 7.
- **Body (field-presence dispatch, D12):** JSON, one of:
  - `{ "content": "<markdown>", "url": "...", "title": "...", "via": "extension" }`
    → write `content` as-is (no fetch).
  - `{ "url": "...", "via": "ios"|"android" }` → server fetches + extracts.
  - `{ "text": "...", "via": "..." }` → write a note.
- **Success response:** **202** with body `{ "status": "queued", "id": "<ingest-log-id>" }`
  so a client can show "Queued ✓" (and later poll, out of scope for v1). The `id`
  is the pending log row (D22).
- **Error responses (all synchronous, teaching messages):** `400` none of
  content/url/text present (name the accepted fields); `401` missing/invalid token;
  `403` valid token of the wrong scope (agent token on `/ingest`); `413`
  request-body over the cap; `429` over rate limit/quota. Endpoint never throws to
  the caller (fail-soft).

## Success criteria (testable)

**Endpoint, contract & async boundary**
1. `POST /ingest` exists on the public listener beside `/mcp`+`/transcript`;
   unknown methods/paths still 404; `chrome-extension://` Origin is accepted. (D3, S1)
2. Field-presence dispatch (D12): none of content/url/text → **400** naming the
   accepted fields.
3. Request body over the cap (~2 MB) → **synchronous 413**. Extracted-markdown
   over-cap (~1 MB) is a **logged failed attempt**, *not* a status to the client
   (it's discovered post-202). (D14, D22)
4. Success returns **202** with `{status:"queued", id}` *after* synchronous
   validation; fetch/extract/write run in the background; the endpoint never throws
   to the caller. (D22)
5. A `pending` ingest-log row is written **before** the 202; it transitions to
   success/failed when background processing completes, so a crash mid-process
   still leaves a recorded attempt. (D22, D7)

**Auth — bidirectional scope isolation (the security core, D21)**
6. The token record carries a `scope` (`agent` | `capture`), surfaced from
   `verifyAgentToken` through `AuthResult`. (`agent-tokens.ts:102-124`,
   `auth.ts:44-47` today expose no scope — this is net-new.)
7. A capture token is **accepted** on `/ingest` and **rejected on `/mcp`** (cannot
   reach the 7 verbs); an **agent** token is **rejected on `/ingest`** (403). A
   regression test pins **both** directions.
8. The localhost no-auth bypass (`auth.ts:79`) does **not** grant `/ingest` access —
   `/ingest` always requires an explicit capture token, even on loopback (so the
   bypass can't masquerade as capture scope and void criterion 7).
9. Capture tokens are minted + revoked from the dashboard; revocation takes effect
   on the next request (`verifyAgentToken` reads the store live). (D2)
10. Each capture token is rate-limited: ~200 captures/day + ~1/sec burst → over
    limit returns **429**; the counter lives in the settings store. (D19)

**Write, naming, dedup, frontmatter**
11. A `content` capture (and, post-Task-6, a fetched `url` capture) writes
    `references/web/<YYYY-MM-DD>-<slug>.md`, slug from title, and **git-commits**
    it; it is immediately returned by `search_references` (lazy index, no build
    step — `corpus-index.ts:167-201`). (D5, D8)
12. Re-capturing the **same URL** overwrites the original path (first-capture date
    prefix kept), refreshing content + `captured_at`, matched via the ingest-log
    **normalized**-URL lookup — strip `#fragment` + tracking params, lowercase host,
    strip trailing slash (D20) — not by re-deriving the slug. (D6, D11)
13. A *different* URL colliding on the same day-slug, and same-day text notes with
    the same first line, get a deterministic uniquifier suffix; create-or-suffix is
    atomic so two concurrent captures can't clobber (handles the `createFile`
    CONFLICT path, `trpc/vault.ts:13`). (D8)
14. A `text` capture writes a note titled from the first non-empty line (truncated),
    fallback `note-<date>`; never dedups. The `url`/`content` path uses the **same**
    empty/unicode-title fallback (an all-emoji/CJK title must not yield
    `web/<date>-.md`). (D15)
15. Ingested frontmatter carries `title`, `source`, `captured_at`, `via`
    (`extension|ios|android`), plus `site`/`byline` when extractable; the body
    stays chunk-searchable. (D13)

**Server fetch safety (D23)**
16. The `url` path resolves the host and validates **every resolved IP** (and every
    redirect hop, re-resolved) against the deny-list: loopback, private, link-local,
    cloud-metadata (`169.254.169.254`), **IPv6 `::1`/`fc00::/7`/`fe80::/10`/
    IPv4-mapped**, and decimal/hex-encoded IPs. The socket is pinned to the
    validated IP (no DNS-rebinding TOCTOU). A blocked target writes nothing and
    logs the refusal.
17. The fetch caps the **response body** size (stream-aborted over cap) and requires
    `Content-Type: text/html` — non-HTML (PDF/JSON/binary) is a logged failed
    attempt, not an extraction attempt. (document ingest stays phase-2.)
18. A fetch timeout / non-2xx / extraction failure logs a **failed** attempt and
    writes no reference; a single legitimate redirect (http→https, canonical)
    **succeeds** (criterion 16 must not break the mobile happy path — D23 vs S2).

**Ingest log & dashboard**
19. Every attempt is a row in the **settings sidecar** (not a relational DB):
    `{id, source, via, status, error?, result_path?, created_at}`. (D24, D9-corrected)
20. `redactSecrets` (core, `transcript-intake.ts:131`) is applied to `source` and
    `error` before they are persisted or rendered — no `user:pass@host` or upstream
    auth leaks into the log or dashboard. (D25)
21. The dashboard "Connect a device" page mints a capture token, shows the server
    URL **with a prominent http/mixed-content warning when not https** (D18), and
    renders the canonical iCloud link **+ QR code** plus extension/Android setup
    values. (D16, D17)
22. The dashboard ingest-log panel lists recent attempts; a **failed** attempt shows
    its (redacted) error + source URL for manual revisit; a success links the
    resulting reference. (D7)

**Clients**
23. The Chromium extension (Chrome + Edge, MV3): options page for server URL +
    capture token; on save it requests `chrome.permissions.request({origins})` for
    the configured server origin (`optional_host_permissions`). Clicking the action,
    the **content script extracts via Defuddle** and messages the result to the
    **background service worker**, which POSTs `{url,title,content,via:"extension"}`
    (SW-fetch sidesteps content-script mixed-content blocking — D26), showing
    "Queued ✓" or a visible error. The options page warns when the server is http. (D1, D26, S1)
24. The iOS Shortcut posts `{url}` (or `{text}`) with the user's pasted server-URL +
    token; the Android HTTP-Shortcuts recipe does the same. End to end, a share →
    Librarian produces a reference. (D4, S2)

## Scope boundaries

**In:** `/ingest` (content/url/text), capture-scope tokens with bidirectional
isolation + rate limit, ingest log + normalized dedup index, SSRF-by-resolved-IP
fetch + Defuddle extraction, Chromium extension, iOS Shortcut + Android recipe,
dashboard "Connect a device" + ingest-log panel.

**Out (explicit):** document/PDF/file ingest (phase 2); auto-tagging/curator
enrichment; multi-tenant / multi-vault / per-user iCloud links (impossible, D16); a
review-approval gate (D5 chose direct); an 8th MCP verb (sacred 7 untouched, D3);
a native compiled share extension (D4); client-side polling of capture status
(202 returns an id but no poll endpoint in v1).

## Key decisions surfaced for review

- **Capture scope required on `/ingest`; agent tokens rejected there** (criterion
  7) and the **localhost bypass does not grant ingest** (criterion 8). Strict
  least-privilege.
- **Private mode does not gate ingest.** `[librarian:private=on]` is a conversation
  marker; external clients carry none, and references aren't memories. Ingest is
  gated by the capture token. (Deliberate boundary — confirm.)
- **http allowed, warned** (D18): the endpoint won't enforce TLS, but the extension
  may be unable to reach an http target (SPIKE-A resolves the real constraint).
- **Each task ships as its own PR** with a version bump + dated CHANGELOG entry; a
  drift-guard assertion confirms `/ingest` adds nothing to the 7-verb registry.

## Open questions

- ~~OQ-A~~ **Resolved by SPIKE-A:** keep Defuddle server-side (linkedom, light); no
  fallback engine.
- ~~OQ-C~~ **Resolved by SPIKE-A:** extension reaches http via background-SW fetch +
  `optional_host_permissions` (D26); D18 stands.
- OQ-B — Android recipe: HTTP-Shortcuts import string vs a tiny share-target stub
  (pick in Task 8 by what distributes cleanest). *(Open — not spike-blocking.)*
- **SPIKE-B (iOS iCloud link) still open** — manual, Jim's to run before Task 8/9.

## Tasks (ordered, vertically sliced)

- [x] **SPIKE-A — Defuddle dual-runtime + extension http reachability proof.** ✅
      Server-side proven empirically; browser-side resolved via docs (D26). Live
      load-unpacked confirmation deferred to Task 7 acceptance.
- [ ] **SPIKE-B — iCloud Shortcut install proof (manual, Jim).**
      Accept: shortcut installs from an iCloud link on a fresh device with
      import-question prompts; no-API + Update-flow behavior confirmed in writing.
- [ ] **Task 1 — Capture-scope tokens: `scope` field + bidirectional isolation.**
      Depends: none. Accept: `TokenRecord.scope` persisted; surfaced via
      `verifyAgentToken`→`AuthResult`; capture token rejected on `/mcp`, agent token
      rejected on a stub `/ingest` (403), localhost bypass denied on `/ingest`;
      mint+revoke via tRPC, revoke effective next request. (crit 6,7,8,9)
- [ ] **Task 2 — Ingest-log rows + normalized dedup index (settings sidecar).**
      Depends: none. Accept: insert `pending`→`success`/`failed`; `lookupByUrl`
      normalizes (strip fragment/tracking/trailing-slash, lowercase host) and returns
      the prior `result_path`; `listRecent`/`listFailures` filter; `redactSecrets`
      applied on write. (crit 5,12,19,20)
- [ ] **Task 3 — `/ingest` skeleton: origin allow-list, capture-auth, parse, size cap, rate limit, error contract.**
      Depends: Task 1. Accept: route on public listener accepting `chrome-extension://`;
      capture-gated (401/403); empty/malformed → 400; >2 MB → 413; over quota → 429;
      writes a `pending` row + returns `202 {status:"queued",id}`; never throws.
      (crit 1,2,3-bodycap,4,5,10)
- [ ] **Task 4 — `content`-path write + dedup + logging.**
      Depends: Tasks 2,3. Accept: `{content,url,title,via}` writes
      `references/web/<date>-<slug>.md` + frontmatter, commits, searchable, logs
      success; re-POST same (normalized) URL overwrites the same path; concurrent
      same-URL/day-slug collisions get an atomic uniquifier; empty/unicode title
      falls back. *(url-only inputs are handled in Task 6, not here.)* (crit 11,12,13,14-content,15)
- [ ] **Task 5 — `text`-note write path.**
      Depends: Task 3. Accept: `{text}` writes a note with first-line title/slug
      (fallback `note-<date>`), never dedups, logs success. (crit 14-text)
- [ ] **Task 6 — SSRF-by-resolved-IP fetch + Defuddle extraction (`url` path).**
      Depends: Task 4, SPIKE-A. Accept: `{url}` to a public page resolves+validates
      every IP/hop, fetches (body-size-capped, `text/html`-gated), extracts, writes
      (reusing Task 4), logs; a legit http→https redirect succeeds; loopback/private/
      link-local/metadata/IPv6/encoded target refused + logged; non-HTML / timeout /
      over-extracted-cap → logged failure, no write. (crit 11-url,16,17,18,3-extractcap)
- [ ] **Task 7 — Chromium extension (MV3) at `clients/chromium-extension`.**
      Depends: Task 4, SPIKE-A. In-tree workspace, NOT a separate repo (D27); its
      own bundler; `/ingest` accepts any `chrome-extension://` origin (D28). Accept:
      load-unpacked in Chrome + Edge; configure URL+token; click on an article →
      reference appears; bad token → visible error; options page documents the http
      limitation. Distribution v1 = load-unpacked / GitHub-release zip; stores are a
      decoupled v2 follow-up (D28). (crit 23)
- [ ] **Task 8 — iOS Shortcut + Android recipe.**
      Depends: Task 6, SPIKE-B. Accept: iCloud-link install prompts for URL+token;
      iOS share → reference written; Android recipe does the same. (crit 24)
- [ ] **Task 9 — Dashboard "Connect a device" page.**
      Depends: Task 1, SPIKE-B (link constant). Accept: mints a capture token, shows
      server URL + http warning, renders iCloud link + QR + extension/Android values;
      Playwright e2e. (crit 21)
- [ ] **Task 10 — Dashboard ingest-log panel.**
      Depends: Tasks 2,6. Accept: failed attempt shows redacted error + source URL;
      success links the reference; Playwright e2e. (crit 22)

Run the dashboard Playwright e2e locally before pushing any `apps/dashboard`
change (Tasks 9, 10).
