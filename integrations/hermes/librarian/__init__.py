"""Hermes Agent Memory Provider plugin backed by The Librarian.

The Hermes entry point is :func:`register`. Hermes calls it under TWO loaders,
each with a different context surface (see ``hermes_cli/plugins.py`` and
``plugins/memory/__init__.py`` in NousResearch/hermes-agent):

- the **memory-provider loader** (``plugins/memory/<name>/`` + the
  ``memory.provider`` config key, or ``hermes memory setup``) — its context
  has ``register_memory_provider`` but no-ops hooks/commands;
- the **general plugin loader** (``hermes plugins enable librarian``) — its
  ``PluginContext`` has ``register_command`` but NO
  ``register_memory_provider``.

So ``register`` guards every call: each loader wires the parts it supports.
The slash commands are optional sugar (rethink D9) — the primer delivered via
``system_prompt_block`` teaches the same protocols, so the provider alone is a
complete install.
"""

from __future__ import annotations

import logging
from typing import Any

# NOTE: the submodule imports live inside register() (local imports), not at
# module scope. Hermes loads this directory by path as a package; generic Python
# tooling may import this __init__ *without* a package context, where top-level
# ``from .x import`` would raise. Deferring them keeps a bare import of this
# file clean; at runtime register() always runs inside the package, so the
# relative imports resolve normally.

__version__ = "1.0.0"

__all__ = ["__version__", "register"]

_logger = logging.getLogger("the_librarian_hermes_plugin")
_LEVELS = {"info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


def _log(level: str, message: str) -> None:
    _logger.log(_LEVELS.get(level, logging.INFO), message)


def register(ctx: Any) -> None:
    """Hermes plugin entry point — wires whatever the calling loader supports.

    Every registration is guarded because the memory-provider loader and the
    general plugin loader expose disjoint context methods (see the module
    docstring); calling an absent one would abort the whole ``register``."""
    from .commands import register_commands
    from .provider import LibrarianProvider

    if hasattr(ctx, "register_memory_provider"):
        ctx.register_memory_provider(LibrarianProvider(logger=_log))
    register_commands(ctx)  # no-op if ctx has no register_command
