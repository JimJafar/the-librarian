// Action popup: a single "Clip this page" button that asks the background SW to
// capture the active tab, plus a status line. The popup may close before the
// background finishes (the toolbar badge is the fallback), but while it's open it
// shows the live result.

import type { SendResult } from "./lib/types.js";

const button = document.getElementById("clip") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const optionsLink = document.getElementById("open-options") as HTMLAnchorElement;

function setStatus(message: string, tone: "idle" | "ok" | "error"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

optionsLink.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

button.addEventListener("click", () => {
  button.disabled = true;
  setStatus("Clipping…", "idle");
  chrome.runtime.sendMessage({ type: "CLIP" }, (result?: SendResult) => {
    button.disabled = false;
    if (chrome.runtime.lastError || !result) {
      setStatus("Couldn't reach the extension background. Try again.", "error");
      return;
    }
    setStatus(result.message, result.ok ? "ok" : "error");
  });
});
