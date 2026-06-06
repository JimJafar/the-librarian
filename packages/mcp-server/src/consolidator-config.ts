// Consolidator (intake) enablement — now a dashboard-editable setting under the
// unified curator namespace (`curator.intake.enabled`, spec 043 D-E). The legacy
// `LIBRARIAN_CONSOLIDATOR` env opt-in is retired to a one-release deprecation:
// it seeds the setting once on first migration and emits a deprecation warning
// while still present, but it NO LONGER gates the job — the setting is
// authoritative, so toggling it from the dashboard takes effect immediately.
//
// Both the http scheduler (whether to start the tick + boot-scan) and the
// `remember` verb (whether to route to the inbox) read `isIntakeEnabled(store)`
// so they can't drift.

import { isIntakeEnabled } from "@librarian/core";
import type { LibrarianStore } from "@librarian/core";

/** The legacy env opt-in, retired to a seed-once + deprecation-warn role (043). */
const LEGACY_CONSOLIDATOR_ENV = "LIBRARIAN_CONSOLIDATOR";

/**
 * True when intake is enabled via the unified `curator.intake.enabled` setting.
 * The setting is authoritative; the legacy env is honoured only by seeding this
 * setting at boot (see migrateCuratorEnablement) — never read here.
 */
export function isConsolidatorEnabled(store: LibrarianStore): boolean {
  return isIntakeEnabled(store);
}

/** The raw legacy env value (for the one-time migration seed). */
export function legacyConsolidatorEnv(): string | undefined {
  return process.env[LEGACY_CONSOLIDATOR_ENV];
}

/**
 * True when the deprecated `LIBRARIAN_CONSOLIDATOR` env var is still set (to any
 * value). Boot code logs a one-line deprecation notice when this is true so
 * operators learn to remove the env and rely on the dashboard setting instead.
 */
export function isLegacyConsolidatorEnvSet(): boolean {
  return process.env[LEGACY_CONSOLIDATOR_ENV] !== undefined;
}
