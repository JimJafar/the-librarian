// Public surface of `the-librarian-cli` as a library.
//
// The bin is the primary consumer, but exporting the runtime + core lets
// the next wave (and tests) import the pieces directly.

export { runCli, usage, type CliResult, type RuntimeOptions } from "./runtime.js";
export {
  readConfig,
  setConfig,
  redact,
  formatConfig,
  deriveServerUrl,
  type LibrarianConfig,
  type RedactedConfig,
  type SetConfigInput,
} from "./config.js";
export {
  detectShell,
  applyShellBlock,
  removeShellBlock,
  writeEnvFile,
  readEnvFile,
  type EnvValues,
  type Shell,
} from "./env.js";
export { machineId, hostname } from "./machine.js";
export { cliVersion } from "./version.js";
export {
  status,
  fetchLatestVersion,
  setLatestFetcher,
  resetLatestFetcher,
  type LatestFetcher,
} from "./status.js";
export {
  doctor,
  setServerProbe,
  resetServerProbe,
  type ServerProbe,
  type ProbeResult,
} from "./doctor.js";
export {
  createPrompter,
  resolveSelection,
  MissingValueError,
  type Prompter,
  type PrompterOptions,
  type PromptFn,
  type PromptTextOptions,
  type HarnessChoice,
} from "./prompt.js";
export { compareVersions, isBehind } from "./semver.js";
export {
  registry,
  allHarnesses,
  HARNESS_IDS,
  isHarnessId,
  NotImplemented,
  type HarnessId,
  type HarnessModule,
  type HarnessConfig,
  type DetectResult,
} from "./harnesses/index.js";
