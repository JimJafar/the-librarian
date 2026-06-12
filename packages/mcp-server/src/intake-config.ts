// Intake (intake) legacy-env helpers. Intake enablement itself now lives in
// core's `isIntakeEnabled(store)` — the single authoritative predicate over the
// dashboard-editable `curator.intake.enabled` setting (spec 043 D-E) — and every
// consumer (http scheduler, `remember`) reads it directly so
// they can't drift (D-5/F21). The only thing left here is the legacy
// `LIBRARIAN_CONSOLIDATOR` env opt-in, retired to a one-release deprecation: it
// seeds the setting once on first migration and emits a deprecation warning while
// still present (read by http boot), but it NO LONGER gates the job — the setting
// is authoritative, so toggling it from the dashboard takes effect immediately.

/** The legacy env opt-in, retired to a seed-once + deprecation-warn role (043). */
const LEGACY_INTAKE_ENV = "LIBRARIAN_CONSOLIDATOR";

/** The raw legacy env value (for the one-time migration seed). */
export function legacyIntakeEnvValue(): string | undefined {
  return process.env[LEGACY_INTAKE_ENV];
}

/**
 * True when the deprecated `LIBRARIAN_CONSOLIDATOR` env var is still set (to any
 * value). Boot code logs a one-line deprecation notice when this is true so
 * operators learn to remove the env and rely on the dashboard setting instead.
 */
export function isLegacyIntakeEnvSet(): boolean {
  return process.env[LEGACY_INTAKE_ENV] !== undefined;
}
