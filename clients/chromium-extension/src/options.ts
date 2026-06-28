// Options page: persist the server URL + capture token, and on save request the
// runtime host permission for the configured server origin (declared in the
// manifest as optional_host_permissions). Shows a live plaintext-http warning
// (D18) because an http server means the token travels in cleartext and the SW
// can only reach it on a LAN/localhost target.

import { loadConfig, saveConfig } from "./lib/config.js";
import { isInsecureServer, parseServerUrl } from "./lib/server-url.js";

const form = document.getElementById("options-form") as HTMLFormElement;
const serverUrlInput = document.getElementById("server-url") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const httpWarning = document.getElementById("http-warning") as HTMLParagraphElement;
const status = document.getElementById("status") as HTMLParagraphElement;

function setStatus(message: string, tone: "ok" | "error" | "idle"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

function refreshHttpWarning(): void {
  httpWarning.hidden = !isInsecureServer(serverUrlInput.value);
}

async function init(): Promise<void> {
  const config = await loadConfig();
  serverUrlInput.value = config.serverUrl;
  tokenInput.value = config.token;
  refreshHttpWarning();
}

serverUrlInput.addEventListener("input", refreshHttpWarning);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void onSave();
});

async function onSave(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim();
  const token = tokenInput.value.trim();

  let originPattern: string;
  try {
    originPattern = parseServerUrl(serverUrl).originPattern;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Invalid server URL.", "error");
    return;
  }
  if (!token) {
    setStatus(
      "Enter the capture token you minted on the dashboard's Connect a device page.",
      "error",
    );
    return;
  }

  // Request the host permission so the background SW can reach this server. Must
  // run in this user-gesture handler. If the user declines, we still save the
  // config but warn the capture won't reach the server yet.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern] });
  } catch {
    granted = false;
  }

  await saveConfig({ serverUrl, token });

  if (granted) {
    setStatus("Saved. The extension can now reach your server.", "ok");
  } else {
    setStatus(
      "Saved, but host access was not granted — captures will fail until you allow access to " +
        `${originPattern} for this extension.`,
      "error",
    );
  }
}

void init();
