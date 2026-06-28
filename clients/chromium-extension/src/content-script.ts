// Content script (D26): runs in the PAGE so it can read the live DOM, but it does
// NOT touch the network. It only extracts the article with Defuddle and hands the
// result to the background service worker, which performs the cross-origin POST
// (a content-script fetch to an http LAN server would be mixed-content-blocked).
//
// It is injected on demand by the background SW (chrome.scripting.executeScript)
// and answers a single EXTRACT message, so Defuddle never runs on page load.

import { extractArticle } from "./lib/extract.js";
import type { ExtractResponse, RuntimeMessage } from "./lib/types.js";

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse: (response: ExtractResponse) => void) => {
    if (message.type !== "EXTRACT") return undefined;

    try {
      const extraction = extractArticle(document);
      sendResponse({ type: "EXTRACTION", extraction });
    } catch (error) {
      // Fail-soft: never throw out of the listener. The SW turns this into a
      // visible "couldn't read this page" status.
      sendResponse({
        type: "EXTRACTION",
        error: error instanceof Error ? error.message : "Could not extract this page.",
      });
    }
    // We responded synchronously above; no need to keep the channel open.
    return false;
  },
);
