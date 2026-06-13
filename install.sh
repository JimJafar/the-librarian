#!/usr/bin/env bash
# The Librarian — one-line bootstrap for the `librarian` cross-harness CLI.
#
# What this does (and nothing more): checks you have Node >= 22, installs the
# published CLI with `npm i -g @the-librarian/cli`, then hands off to
# `librarian install` (interactive — it asks for your MCP URL + agent token and
# lets you pick which harnesses to wire up).
#
# Inspect-first is the recommended path. Piping a script to a shell is opt-in,
# never the only way:
#
#     curl -fsSL https://raw.githubusercontent.com/JimJafar/the-librarian/main/install.sh -o install.sh
#     less install.sh        # read it — it's short
#     bash install.sh
#
# The one-liner (curl … | bash) does the same thing for those who'd rather not.
# This script installs NO runtime for you: if Node is missing it tells you where
# to get it and stops, so it never silently pulls a toolchain onto your machine.

set -eu

CLI_PACKAGE="@the-librarian/cli"
MIN_NODE_MAJOR=22

say() {
  printf '[librarian] %s\n' "$1"
}

die() {
  printf '[librarian] error: %s\n' "$1" >&2
  exit 1
}

# --- 1. Node >= 22 ----------------------------------------------------------
say "Checking for Node.js >= ${MIN_NODE_MAJOR}…"

if ! command -v node >/dev/null 2>&1; then
  die "Node.js was not found on your PATH.
  The Librarian CLI needs Node.js >= ${MIN_NODE_MAJOR}. Install it, then re-run this script:
    - download:  https://nodejs.org/  (the LTS build is fine)
    - or use nvm: https://github.com/nvm-sh/nvm  (\`nvm install ${MIN_NODE_MAJOR}\`)
  This script will not install a runtime for you."
fi

node_version="$(node --version)"            # e.g. v22.10.5
node_major="${node_version#v}"              # strip leading v -> 22.10.5
node_major="${node_major%%.*}"             # keep major -> 22

case "$node_major" in
  '' | *[!0-9]*)
    die "Could not parse the Node.js version from '${node_version}'. Expected something like v22.10.5."
    ;;
esac

if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  die "Found Node.js ${node_version}, but The Librarian CLI needs >= ${MIN_NODE_MAJOR}.
  Upgrade Node, then re-run this script:
    - download:  https://nodejs.org/
    - or use nvm: https://github.com/nvm-sh/nvm  (\`nvm install ${MIN_NODE_MAJOR}\`)"
fi

say "Found Node.js ${node_version}."

# --- 2. npm -----------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  die "npm was not found on your PATH (it ships with Node.js). Reinstall Node from https://nodejs.org/."
fi

# --- 3. Install the CLI -----------------------------------------------------
# Idempotent: re-running just installs the latest published version over the top.
say "Installing ${CLI_PACKAGE} globally (npm i -g ${CLI_PACKAGE})…"
npm i -g "$CLI_PACKAGE"

say "Installed. Handing off to \`librarian install\` (it'll ask for your MCP URL + token)…"

# --- 4. Run the interactive installer ---------------------------------------
# `exec` replaces this script so `librarian install` owns the terminal — its
# interactive prompts (URL/token, harness multi-select) get a real TTY.
exec librarian install
