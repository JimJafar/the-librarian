"""The Librarian-backed Hermes Memory Provider (rethink v1.0 — 7-verb surface).

Maps the Hermes ``MemoryProvider`` hooks onto The Librarian's 7 MCP tools via
:class:`client.LibrarianClient`. Three invariants dominate:

- **The 7-verb agent contract.** ``get_tool_schemas()`` advertises exactly
  ``recall``, ``remember``, ``flag_memory``, ``store_handoff``,
  ``list_handoffs``, ``claim_handoff``, ``search_references``. Each schema's
  parameters mirror the server's advertised ``inputSchema``
  (``packages/mcp-server/src/mcp/tools/*.ts``), minus the fields the provider
  resolves itself (``agent_id`` and the ``claiming_*`` provenance, injected
  from config) and the retired ``conv_id``.
- **The primer is the only prompt injection.** ``system_prompt_block()``
  returns the operator-editable primer fetched once per session from
  ``GET /primer.md`` — verbatim, no wording of our own (Hermes regex-screens
  MCP-adjacent content; the server-side primer is already screened). The old
  per-turn prefetch / conv-state machinery is gone (rethink D10): the ABC
  marks ``prefetch``/``sync_turn``/``on_pre_compress``/``on_session_end``
  non-abstract, so they are simply not implemented here.
- **Fail-soft.** A Librarian / network failure is logged and swallowed — a
  turn is never blocked. ``handle_tool_call`` always returns a JSON string
  (the ABC's contract): ``{"ok": true, "result": …}`` on success, an
  ``{"ok": false, "error": {…}}`` envelope on any failure, never a raise.

The Hermes ``MemoryProvider`` ABC lives in the Hermes codebase (provided at
runtime), not installed here, so we subclass it when importable and ``object``
otherwise. Method names/shapes match ``agent/memory_provider.py`` in
NousResearch/hermes-agent (``handle_tool_call(tool_name, args, **kwargs)``;
``initialize(session_id, **kwargs)`` with ``hermes_home`` in kwargs).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .client import LibrarianClient, LibrarianClientError

if TYPE_CHECKING:
    _Base = object
else:
    try:  # pragma: no cover - exercised only inside a real Hermes runtime
        from agent.memory_provider import MemoryProvider as _Base
    except ImportError:
        _Base = object

LogFn = Callable[[str, str], None]

_CONFIG_FILENAME = "config.json"
_PROVIDER_NAME = "librarian"
_HARNESS = "hermes"


# ---------------------------------------------------------------------------
# Config — non-secret values in $HERMES_HOME/librarian-plugin/config.json,
# the bearer token ONLY from the LIBRARIAN_AGENT_TOKEN env var.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LibrarianConfig:
    endpoint: str
    token: str
    agent_id: str | None = None
    project_key: str | None = None
    timeout_ms: int = 15000


def config_schema() -> list[dict[str, Any]]:
    """Field descriptors for ``hermes memory setup`` (the get_config_schema body)."""
    return [
        {
            "key": "endpoint",
            "description": "Librarian HTTP MCP endpoint URL",
            "url": True,
            "required": True,
            "secret": False,
        },
        {
            "key": "token",
            "description": "Librarian agent bearer token",
            "secret": True,
            "required": True,
            "env_var": "LIBRARIAN_AGENT_TOKEN",
        },
        {
            "key": "agent_id",
            "description": "Canonical agent id (optional if the token is agent-bound)",
            "required": False,
            "secret": False,
        },
        {
            "key": "project_key",
            "description": "Default project scope (optional)",
            "required": False,
            "secret": False,
        },
        {
            "key": "timeout_ms",
            "description": "Per-call timeout in ms",
            "required": False,
            "secret": False,
            "default": 15000,
        },
    ]


def _config_path(hermes_home: str) -> Path:
    return Path(hermes_home) / "librarian-plugin" / _CONFIG_FILENAME


def save_config(values: dict[str, Any], hermes_home: str) -> None:
    """Persist non-secret config under hermes_home. The token is never written —
    it comes from the LIBRARIAN_AGENT_TOKEN env var at load time."""
    path = _config_path(hermes_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    non_secret = {k: v for k, v in values.items() if k != "token"}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(non_secret).encode("utf-8"))
    finally:
        os.close(fd)
    path.chmod(0o600)


def load_config(hermes_home: str, env: dict[str, str]) -> LibrarianConfig | None:
    """Load config (non-secret from hermes_home, token from env). Returns None if
    not fully configured."""
    path = _config_path(hermes_home)
    values: dict[str, Any] = {}
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        values = {}
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(values, dict):
        return None
    endpoint = values.get("endpoint")
    token = env.get("LIBRARIAN_AGENT_TOKEN")
    if not isinstance(endpoint, str) or not endpoint or not token:
        return None
    timeout = values.get("timeout_ms")
    return LibrarianConfig(
        endpoint=endpoint,
        token=token,
        agent_id=values.get("agent_id") or None,
        project_key=values.get("project_key") or None,
        timeout_ms=int(timeout) if isinstance(timeout, int) else 15000,
    )


# ---------------------------------------------------------------------------
# The 7 tool schemas (OpenAI function format, per the ABC).
#
# Source of truth: the server's advertised inputSchemas in
# packages/mcp-server/src/mcp/tools/{recall,remember,flag-memory,store-handoff,
# list-handoffs,claim-handoff,search-references}.ts (+ schemas.ts for
# `remember`). Differences are deliberate and provider-resolved:
#   - `agent_id` / `project_key` scoping and `claiming_*` provenance are
#     injected from config (see _scoped_args), not asked of the model;
#   - `include_ids` is always set to true on recall so flag_memory has a
#     target;
#   - recall tightens `query` to required (the server leaves it optional, but
#     an unqueried recall is never what the model wants);
#   - the retired `conv_id` and curator-side fields (visibility/scope/
#     priority/confidence/applies_to) are not advertised.
# tests/test_schemas.py pins this parity against the TS sources.
# ---------------------------------------------------------------------------


def tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "name": "recall",
            "description": (
                "Search durable memory before acting — at task start, or whenever "
                "prior context, a stored preference, or a past decision would help. "
                "Query by free text; `tags` narrows to memories carrying any of the "
                "supplied tags. Each result is prefixed with its memory id (e.g. "
                "`[mem_…]`) — if a recalled memory turns out to be wrong, misleading, "
                "or outdated, pass that id to `flag_memory` with a `reason`."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "project_key": {"type": "string"},
                    "limit": {"type": "number"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "remember",
            "description": (
                "Save a durable fact, preference, or decision worth recalling in a "
                "later session — not transient chatter. Give it a short `title`, a "
                "self-contained `body`, and a `category`; add `tags` and a "
                "`project_key` so it surfaces in the right context. Protected "
                "memories route to a review queue automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "category": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "project_key": {"type": "string"},
                },
                "required": ["title", "body", "category"],
            },
        },
        {
            "name": "flag_memory",
            "description": (
                "Flag a recalled memory you believe is incorrect, misleading, or "
                "outdated, with a short free-text `reason`. The flag routes the "
                "memory to human review and ranks it below unflagged matches in "
                "recall — it never edits, archives, or deletes the memory, and there "
                "is no 'this was useful' counterpart. Use it sparingly, only when a "
                "memory actively led you astray. The `memory_id` is the id in "
                "brackets from a preceding `recall` result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "memory_id": {"type": "string"},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 2000},
                },
                "required": ["memory_id", "reason"],
            },
        },
        {
            "name": "store_handoff",
            "description": (
                "Persist a handoff document so another agent (or harness) can resume "
                "your work later. Use it when you're pausing mid-task or ending a "
                "session that isn't finished. The document must follow the "
                "five-section template — Start & intent, Journey, Current state, "
                "What's left, Open questions — or it is rejected."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 5, "maxLength": 120},
                    "document_md": {"type": "string", "minLength": 100, "maxLength": 50000},
                    "project_key": {"type": ["string", "null"]},
                    "source_ref": {"type": ["string", "null"]},
                    "cwd": {"type": ["string", "null"]},
                    "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
                },
                "required": ["title", "document_md"],
            },
        },
        {
            "name": "list_handoffs",
            "description": (
                "List unclaimed handoffs you could pick up — call this before "
                "resuming work to see what's waiting. Default scope is the current "
                "project_key + cwd when both are supplied; drop either to broaden "
                "when nothing matches. Then `claim_handoff` the one you want."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_key": {"type": ["string", "null"]},
                    "cwd": {"type": ["string", "null"]},
                    "harness": {"type": ["string", "null"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
            },
        },
        {
            "name": "claim_handoff",
            "description": (
                "Atomically claim a handoff and return its document. Fails with "
                "`not_found` if the id is unknown; `already_claimed` if another "
                "agent got there first (the existing claim is included so you can "
                "report it)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "handoff_id": {"type": "string", "minLength": 1},
                },
                "required": ["handoff_id"],
            },
        },
        {
            "name": "search_references",
            "description": (
                "Search reference docs (references/) by query. Returns each match's "
                "path + the relevant section. References are background material — "
                "they are not in normal recall; use this to look them up on demand."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to look up in the references.",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["query"],
            },
        },
    ]


TOOL_NAMES: frozenset[str] = frozenset(schema["name"] for schema in tool_schemas())


def _error_result(kind: str, message: str) -> str:
    """Fail-soft tool result: a JSON error envelope, never a raised exception.
    The message never carries the token (the client guarantees that)."""
    return json.dumps({"ok": False, "error": {"kind": kind, "message": message}})


class LibrarianProvider(_Base):
    """Hermes Memory Provider backed by The Librarian (7-verb surface)."""

    def __init__(
        self,
        *,
        client: LibrarianClient | None = None,
        config: LibrarianConfig | None = None,
        logger: LogFn | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self._client = client
        self._config = config
        self._log: LogFn = logger or (lambda _level, _msg: None)
        self._env = env if env is not None else dict(os.environ)
        # Session-scoped primer cache; only a successful fetch is cached, so a
        # transient failure retries on the next call instead of going dark.
        self._primer: str | None = None

    # ---- identity / availability / config (the ABC surface) ----

    @property
    def name(self) -> str:
        return _PROVIDER_NAME

    def is_available(self) -> bool:
        # Config-only check per the ABC ("should not make network calls").
        if self._config is None:
            hermes_home = self._resolve_hermes_home()
            if hermes_home is not None:
                self._config = load_config(hermes_home, self._env)
        return self._config is not None

    def get_config_schema(self) -> list[dict[str, Any]]:
        return config_schema()

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        save_config(values, hermes_home)

    # ---- lifecycle ----

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Agent startup: load config and wire the HTTP client. There is no
        per-session server state in the 7-verb surface, so the session id is
        unused. Never raises — an unconfigured provider just goes inert."""
        del session_id
        if self._config is None:
            hermes_home = kwargs.get("hermes_home")
            if not isinstance(hermes_home, str):
                self._log(
                    "error", "librarian: no hermes_home supplied; provider inert this session"
                )
                return
            self._config = load_config(hermes_home, self._env)
        if self._client is None and self._config is not None:
            try:
                self._client = LibrarianClient(
                    self._config.endpoint, self._config.token, timeout_ms=self._config.timeout_ms
                )
            except ValueError as err:
                # A non-http(s) endpoint in config: log + stay inert (fail-soft).
                self._log("error", f"librarian: invalid endpoint in config: {err}")

    def shutdown(self) -> None:
        self._client = None
        self._primer = None

    # ---- system prompt (the primer — D10's connect-time channel) ----

    def system_prompt_block(self) -> str:
        """The operator-editable primer from ``GET /primer.md``, verbatim.

        Cached for the session after the first successful fetch. Fail-soft:
        any error returns an empty string and the prompt assembles without us
        — the user's work is never blocked on the Librarian being reachable.
        No local wording is added: the server-side primer is already screened
        against injection-shaped phrasing (Hermes regex-screens this content).
        """
        if self._primer is not None:
            return self._primer
        if self._client is None:
            return ""
        try:
            primer = self._client.fetch_primer()
        except LibrarianClientError as err:
            self._log("warn", f"librarian: primer fetch failed: {err}")
            return ""
        self._primer = primer
        return primer

    # ---- agent-facing tools ----

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return tool_schemas()

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        """Proxy one of the 7 verbs over HTTP MCP (``tools/call``).

        Always returns a JSON string per the ABC contract and never raises:
        ``{"ok": true, "result": <server text>}`` on success,
        ``{"ok": false, "error": {"kind", "message"}}`` on any failure.
        """
        del kwargs
        if tool_name not in TOOL_NAMES:
            return _error_result("unknown_tool", f"Unknown Librarian tool: {tool_name}")
        if not isinstance(args, dict):
            return _error_result("bad_args", f"{tool_name} expects an object of arguments")
        if self._client is None:
            return _error_result(
                "unconfigured", "The Librarian provider is not configured; call skipped"
            )
        try:
            text = self._client.call_tool(tool_name, self._scoped_args(tool_name, args))
        except LibrarianClientError as err:
            self._log("warn", f"librarian: {tool_name} failed: {err}")
            return _error_result(err.kind, str(err))
        return json.dumps({"ok": True, "result": text})

    def _scoped_args(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Inject config-resolved scoping the model shouldn't have to supply.
        Caller-supplied values always win (setdefault only).

        - recall/remember: `agent_id` + `project_key`, and recall always asks
          for ids so a later flag_memory has something to target;
        - store_handoff/list_handoffs: `project_key`; store_handoff also stamps
          `harness: hermes` provenance;
        - claim_handoff: `claiming_agent_id` + `claiming_harness`;
        - flag_memory (keyed by the global memory_id) and search_references
          pass through verbatim.
        """
        out = dict(args)
        agent_id = self._config.agent_id if self._config else None
        project_key = self._config.project_key if self._config else None
        if tool_name in ("recall", "remember"):
            if agent_id:
                out.setdefault("agent_id", agent_id)
            if project_key:
                out.setdefault("project_key", project_key)
        if tool_name in ("store_handoff", "list_handoffs") and project_key:
            out.setdefault("project_key", project_key)
        if tool_name == "recall":
            out.setdefault("include_ids", True)
        if tool_name == "store_handoff":
            out.setdefault("harness", _HARNESS)
        if tool_name == "claim_handoff":
            if agent_id:
                out.setdefault("claiming_agent_id", agent_id)
            out.setdefault("claiming_harness", _HARNESS)
        return out

    # ---- helpers ----

    def _resolve_hermes_home(self) -> str | None:
        home = self._env.get("HERMES_HOME")
        if home:
            return home
        user_home = self._env.get("HOME")
        return str(Path(user_home) / ".hermes") if user_home else None
