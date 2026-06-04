// Settings store — the SQLite implementation was removed (markdown backend only,
// spec 040). The type contract lives in `settings-types.ts`; re-exported from this
// old path so importers don't change. The markdown backend uses the sidecar
// `createJsonSettingsStore`.
export type { SettingMeta, SettingsStore } from "./settings-types.js";
