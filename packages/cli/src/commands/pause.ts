import { type Command, runLifecycle } from "./_shared.js";

export const pause: Command = (store, positionals, flags) =>
  runLifecycle(store, "pause", positionals[0], flags);
