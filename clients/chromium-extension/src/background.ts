// Background service worker (D26): the ONLY place the extension talks to the
// network. It orchestrates a capture: inject the content script into the active
// tab, ask it to extract, build the payload, and POST it to the user's server.
// Running the fetch here (extension origin) instead of in the content script
// (page origin) sidesteps mixed-content blocking when the server is plain http.

import { loadConfig } from "./lib/config.js";
import { buildPayload } from "./lib/payload.js";
import { sendCapture } from "./lib/send.js";
import type { ExtractResponse, RuntimeMessage, SendResult } from "./lib/types.js";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type !== "CLIP") return undefined;
  // Keep the message channel open for the async clip; resolve via sendResponse.
  clipActiveTab()
    .then((result) => {
      void reflectBadge(result);
      sendResponse(result);
    })
    .catch((error) => {
      // Belt-and-braces: clipActiveTab is itself fail-soft, but never let an
      // unexpected rejection escape the listener.
      const result: SendResult = {
        ok: false,
        kind: "server-error",
        message: error instanceof Error ? error.message : "Capture failed unexpectedly.",
      };
      void reflectBadge(result);
      sendResponse(result);
    });
  return true;
});

async function clipActiveTab(): Promise<SendResult> {
  const config = await loadConfig();
  if (!config.serverUrl.trim() || !config.token.trim()) {
    return {
      ok: false,
      kind: "not-configured",
      message: "Not configured — open the options page to set your server URL and capture token.",
    };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return { ok: false, kind: "server-error", message: "No active tab to capture." };
  }
  if (!/^https?:/i.test(tab.url)) {
    return {
      ok: false,
      kind: "server-error",
      message: "This page can't be clipped — open a normal web article and try again.",
    };
  }

  let extraction: ExtractResponse;
  try {
    extraction = await extractFromTab(tab.id);
  } catch {
    return {
      ok: false,
      kind: "server-error",
      message: "Couldn't read this page — reload it and try again.",
    };
  }
  if (extraction.error || !extraction.extraction) {
    return {
      ok: false,
      kind: "server-error",
      message: extraction.error ?? "Couldn't extract this page.",
    };
  }

  const payload = buildPayload(extraction.extraction, tab.url);
  return sendCapture(payload, config);
}

/** Inject the content script on demand, then ask it to extract the live DOM. */
async function extractFromTab(tabId: number): Promise<ExtractResponse> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  return (await chrome.tabs.sendMessage(tabId, { type: "EXTRACT" })) as ExtractResponse;
}

/** Reflect the outcome on the toolbar badge so it's visible even if the popup closed. */
async function reflectBadge(result: SendResult): Promise<void> {
  try {
    const text = result.ok ? "✓" : "!";
    const color = result.ok ? "#1f7a3d" : "#b03a2e";
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: "" });
    }, 4000);
  } catch {
    // Badge is best-effort; a failure here must not affect the capture result.
  }
}
