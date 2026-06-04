// Admin settings / secret store — shared type contract (memory-curator spec §7.1).
//
// The backend-agnostic surface for the operator settings store: `SettingMeta`
// (the listing shape, which never carries a value — secret or otherwise) and
// the `SettingsStore` interface. The concrete SQLite implementation lives in
// `settings-store.ts` and re-exports these for back-compat; `SettingMeta` is
// also consumed by `llm-connection.ts`.

export interface SettingMeta {
  key: string;
  is_secret: boolean;
  updated_at: string;
}

export interface SettingsStore {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting: (key: string) => void;
  /** Metadata for every setting — never includes values (secret or otherwise). */
  listSettings: () => SettingMeta[];
}
