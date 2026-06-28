import type { CaptureConfig } from "./types.js";

const STORAGE_KEY = "librarian.capture.config";

const EMPTY: CaptureConfig = { serverUrl: "", token: "" };

/**
 * Read the persisted capture config from `chrome.storage.local`. Fail-soft:
 * returns empty config rather than throwing, so a storage glitch surfaces as
 * "Not configured", never an uncaught error in a popup/SW turn.
 */
export async function loadConfig(): Promise<CaptureConfig> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY] as Partial<CaptureConfig> | undefined;
    return {
      serverUrl: typeof value?.serverUrl === "string" ? value.serverUrl : "",
      token: typeof value?.token === "string" ? value.token : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist the capture config. The token lives only in extension-local storage. */
export async function saveConfig(config: CaptureConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}
