# Pi integration

Thin, conservative integration package for the Pi harness. Per the spec, the exact Pi runtime interface is an open question — this package ships a minimal, low-dependency setup that you can adapt once Pi's surface is locked down.

## Status

**Conservative MVP.** The spec acknowledges:

> Open question: define the exact Pi runtime interface before implementation.

Until that's resolved, this package:

- Uses the CLI (`the-librarian sessions ...`) rather than assuming HTTP MCP from the device.
- Defaults capture mode to `summary` (never `log`).
- Avoids harness-specific behaviour beyond the documented `/lib:session` contract.
- Provides a minimal wrapper that wraps any Pi runtime invocation.

Treat the wrapper and config as starting points; revisit when Pi's interface is finalised.

## Install

1. **Decide on the transport.** If the Pi device can reach the canonical Librarian HTTP MCP endpoint (network reachability + agent token), prefer that. Otherwise, the wrapper falls back to CLI calls against a local `the-librarian` binary (which itself reaches the canonical instance over HTTP).

2. **Drop [`AGENTS.md`](./AGENTS.md) into the Pi runtime's prompt path** (or merge with an existing system-prompt snippet).

3. **Configure** the Pi runtime using [`config.example.yaml`](./config.example.yaml) as a starting point.

4. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket Pi runtime invocations:
   ```sh
   chmod +x integrations/pi/wrapper.sh
   integrations/pi/wrapper.sh --project the-librarian -- pi-runtime
   ```

5. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Capture mode

Default: **`summary`** (or `off` on extremely constrained devices). **Never `log`.** Raw transcript capture for Pi traffic is reserved for explicit operator request through the safe-fallback-capture mechanism documented in `proposals/safe-fallback-capture.md`.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec (and the open Pi-runtime question): [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)
