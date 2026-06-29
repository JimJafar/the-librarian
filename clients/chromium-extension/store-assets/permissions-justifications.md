# Chrome Web Store — permission justifications

Copy-paste answers for the store submission's "Privacy practices" tab.
The extension declares: `permissions: ["activeTab", "scripting", "storage"]`,
`optional_host_permissions: ["http://*/*", "https://*/*"]`, manifest v3, and
bundles all code (no remote code).

---

## Single purpose description

The Librarian Web Clipper has one purpose: save the article on the page you're
currently viewing into your own self-hosted Librarian server as a clean Markdown
reference. When you click the toolbar button, it extracts the main content of the
current page, converts it to Markdown, and sends it to the Librarian server URL
you configured. It does nothing else.

---

## activeTab justification

`activeTab` lets the extension read the contents of the current tab **only** when
you explicitly click the extension's toolbar button. That click is the whole
feature: it's how the extension knows which page you want to clip, and it grants
temporary access to just that one tab for that one action. The extension never
reads tabs in the background, never accesses other tabs, and takes no action
without your click.

---

## scripting justification

`scripting` is used to inject the extraction script into the active tab — only in
response to your toolbar click (scoped to that tab via `activeTab`). The injected
script reads the page's article content using a bundled readability library,
converts it to Markdown, and hands the result back to the extension to send to
your server. Injecting into the current page is the only way to extract the
article you're reading; the extension does not inject into pages otherwise.

---

## storage justification

`storage` persists your two configuration values — your Librarian server URL and
your capture token — which you enter on the extension's Options page. They're
saved with `chrome.storage` so they survive browser restarts and so the
background service worker can read them to send each capture to your server. No
page content, browsing history, or any other data is stored; these settings stay
local to your browser and are never transmitted anywhere except, as the server
URL/token, to the server you configured.

---

## Remote code justification (if applicable)

Not applicable — the extension executes no remote code. All JavaScript, including
the article-extraction library, plus all assets (fonts), are bundled inside the
extension package. The only network request the extension makes is a `fetch()`
that POSTs the captured page content to the Librarian server URL **you** configure
— that transfers data, never code. The extension never downloads, injects, or
evaluates script from a remote source, and uses the default Manifest V3 content
security policy (no overrides).

---

## Host permissions justification (optional — if the form asks)

The extension requests host permission for **your configured Librarian server's
origin only**, granted at runtime when you save the server URL on the Options page
(`optional_host_permissions` + `chrome.permissions.request`). It is needed so the
background service worker can POST your captured articles to that server's
`/ingest` endpoint. The extension does not use host permissions to read or modify
the pages you visit — page access is via `activeTab` on your click — and it
contacts no origin other than the server you set.

---

## Data use disclosures (for the "Data" section)

- **What's collected/sent:** the content of a page is sent **only when you click
  to clip it**, and **only to the Librarian server URL you configure** (your own
  self-hosted instance).
- **Not sold, not shared with third parties, not used for anything else.** The
  developer (Code Ministry) receives no data — captures go directly from your
  browser to your server.
- **Stored locally:** your server URL and capture token (in `chrome.storage`).
- The capture token is least-privilege: it can only file references and cannot
  read your memories or reach any other server function.
