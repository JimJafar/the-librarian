// Settings store. The type contract lives in `settings-types.ts`; re-exported
// from this old path so importers don't change. The concrete store is the
// sidecar `createJsonSettingsStore`.
export type { SettingMeta, SettingsStore } from "./settings-types.js";
