# The Librarian — Chromium Web Clipper

An MV3 browser extension (Chrome + Edge — both Chromium) that clips the article
you're reading to your Librarian vault as a clean Markdown **reference**. Click
the toolbar action, the extension extracts the page with
[Defuddle](https://github.com/kepano/defuddle), and your Librarian server saves
it under `references/web/<date>-<slug>.md`.

This is `clients/chromium-extension` in the monorepo (decision D27 — a future
`clients/firefox-extension` is why it isn't just `clients/extension`).

## How it works (the load-bearing design — D26)

```
toolbar click → popup → background service worker
                            │  inject content script into the active tab
                            ▼
                       content script  ──Defuddle on the live DOM──▶ { title, content (markdown), site?, byline? }
                            │  message the extraction back
                            ▼
                       background SW  ──POST {url,title,content,via,site?,byline?}──▶  <serverUrl>/ingest
                            │  Authorization: Bearer <capture-token>
                            ▼
                       "Queued ✓" / a readable error  (popup status + toolbar badge)
```

The **content script** only reads the DOM and extracts — it never touches the
network. The **background service worker** performs the `fetch()` POST. This
split is deliberate: a content script runs in the *page's* origin, so a fetch
from an `https` page to an `http` LAN server is mixed-content-blocked; the
service worker runs in the *extension* origin and, with a granted host
permission, can reach `http`. So the POST happens in the SW (D26).

## Build

```sh
pnpm --filter @librarian/chromium-extension build      # → dist/ (loadable unpacked)
pnpm --filter @librarian/chromium-extension package    # → release/librarian-chromium-extension.zip
pnpm --filter @librarian/chromium-extension test       # build + vitest
pnpm --filter @librarian/chromium-extension typecheck
pnpm --filter @librarian/chromium-extension lint
```

The bundler is **esbuild** (`esbuild.config.mjs`): it bundles the content
script (with Defuddle inlined), the service worker, and the options/popup scripts
into `dist/`, then copies `manifest.json`, the HTML, and the icons. The icons are
generated placeholders (`pnpm … icons`) — replace before a store submission.

## Load it (Chrome **and** Edge)

1. `pnpm --filter @librarian/chromium-extension build`.
2. Chrome: open `chrome://extensions`. Edge: open `edge://extensions`.
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select the **`dist/`** folder.
5. Pin the extension so its toolbar action is visible.

Distribution v1 is load-unpacked / the GitHub-release `.zip` (D28). The Chrome
Web Store + Edge Add-ons listings are a decoupled v2 follow-up — the server
accepts any `chrome-extension://` origin (the capture token is the gate), so the
store-vs-unpacked extension IDs don't matter.

## Configure

1. On your Librarian **dashboard**, open **“Connect a device”** (Task 9) and mint
   a **capture token**. That page also shows your server URL.
2. Open the extension's **options** (right-click the action → Options, or the
   popup's *Settings* link).
3. Paste your **server URL** (e.g. `https://librarian.example.com`) and the
   **capture token**, then **Save & grant access**. Saving triggers a
   `chrome.permissions.request` for your server's origin so the service worker
   may reach it (declared as `optional_host_permissions` in the manifest). Accept
   the browser's permission prompt.

The token is stored only in this browser's extension storage. It is
**capture-scope** — it can only reach `/ingest`, never your agent tools.

## The `http` / mixed-content caveat (D18 / D26)

If your server URL is `http://…`, the options page shows a warning, because:

- **The token travels in cleartext.** Anyone on the network path can read it.
- **An `http` server is only reachable on your LAN or `localhost`.** The service
  worker can reach a permitted `http` origin, but browsers still restrict
  plaintext to private/loopback targets in practice. A server reachable from the
  public internet should use **`https://`**.

For a remote self-hosted Librarian, put it behind TLS (a reverse proxy with a
certificate) and use the `https://` URL. `http://localhost:<port>` or a LAN IP is
fine for local testing.

## Privacy / data note (for the eventual store listings — D28)

This extension **sends the content of the page you clip to the server you
configure** — and nothing else, nowhere else. There is no analytics, no
third-party endpoint, and no background collection. It transmits only when you
click the action, only the extracted article + its URL/title, only to your own
Librarian server, authenticated with your capture token. The token is stored
locally and sent solely in the `Authorization` header (never in a URL or log).

## Tests

Unit tests (vitest) cover the pure logic that doesn't need a browser:

- `payload.test.ts` — the exact `/ingest` body builder (omits `site`/`byline`
  when absent).
- `server-url.test.ts` — server-URL normalization + the `http` warning predicate.
- `send.test.ts` — the SW send logic against a mocked `fetch`: 202→queued and
  401/403/413/429/network→the right user-facing status; the Bearer header is
  sent; the token is never logged or placed in the URL.
- `extract-mapping.test.ts` — the extraction wrapper's field mapping (Defuddle
  mocked), deterministic.
- `extract.test.ts` — the **real** Defuddle browser build run against a sample
  HTML document under jsdom, asserting it returns a title + the article prose.

> **jsdom limitation (honest):** Defuddle's browser build uses layout +
> `getComputedStyle` to score and prune content, which jsdom only stubs. Under
> jsdom it falls back to the whole-body path rather than producing cleaned,
> nav-stripped Markdown. Clean-Markdown extraction is proven server-side via
> `defuddle/node` (SPIKE-A) and is verified in a real browser as the manual step
> below.

## Manual verification (human — the deferred end-to-end step)

This cannot be done in CI (it needs a real browser):

1. `pnpm --filter @librarian/chromium-extension build`.
2. Load `dist/` unpacked in Chrome **and** in Edge (steps above).
3. Open the options page; configure your **server URL + capture token**; accept
   the host-permission prompt. Confirm the **`http` warning shows** for an
   `http://` URL and not for `https://`.
4. Open a normal web **article** and click the toolbar action.
5. Confirm the popup shows **“Queued ✓”** (and the toolbar badge shows `✓`).
6. Confirm a **reference appears in your vault** (`references/web/<date>-<slug>.md`)
   and is returned by `search_references`.
7. Negative check: set a **bad token**, clip again, and confirm a readable
   **“Unauthorized — check your capture token”** error (not a stack trace).
