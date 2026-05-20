import { type Command, runLifecycle } from "./_shared.js";

export const checkpoint: Command = (store, positionals, flags) =>
  runLifecycle(store, "checkpoint", positionals[0], flags);
