import { type Command, runLifecycle } from "./_shared.js";

export const end: Command = (store, positionals, flags) =>
  runLifecycle(store, "end", positionals[0], flags);
