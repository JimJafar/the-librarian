"""Config handling — non-secret JSON under $HERMES_HOME, token from env only."""

from __future__ import annotations

import json
import os
from pathlib import Path

from librarian.provider import (
    LibrarianProvider,
    config_schema,
    load_config,
    save_config,
)


def test_load_and_save_round_trip(tmp_path) -> None:
    hermes_home = str(tmp_path)
    save_config(
        {"endpoint": "https://e/mcp", "agent_id": "a1", "project_key": "p1", "timeout_ms": 5000},
        hermes_home,
    )
    cfg = load_config(hermes_home, {"LIBRARIAN_AGENT_TOKEN": "tok"})
    assert cfg is not None
    assert cfg.endpoint == "https://e/mcp"
    assert cfg.token == "tok"
    assert cfg.agent_id == "a1"
    assert cfg.project_key == "p1"
    assert cfg.timeout_ms == 5000


def test_token_is_never_written_to_disk(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp", "token": "super-secret"}, str(tmp_path))
    path = tmp_path / "librarian-plugin" / "config.json"
    on_disk = path.read_text(encoding="utf-8")
    assert "super-secret" not in on_disk
    assert "token" not in json.loads(on_disk)


def test_config_file_and_dir_permissions_are_tight(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp"}, str(tmp_path))
    path = tmp_path / "librarian-plugin" / "config.json"
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"
    assert oct(os.stat(path.parent).st_mode & 0o777) == "0o700"


def test_load_config_returns_none_when_token_missing(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp"}, str(tmp_path))
    assert load_config(str(tmp_path), {}) is None


def test_load_config_returns_none_when_endpoint_missing(tmp_path) -> None:
    save_config({"agent_id": "a1"}, str(tmp_path))
    assert load_config(str(tmp_path), {"LIBRARIAN_AGENT_TOKEN": "tok"}) is None


def test_load_config_returns_none_on_corrupt_json(tmp_path) -> None:
    path = Path(tmp_path) / "librarian-plugin" / "config.json"
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    assert load_config(str(tmp_path), {"LIBRARIAN_AGENT_TOKEN": "tok"}) is None


def test_load_config_defaults_timeout_when_absent_or_bad(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp", "timeout_ms": "soon"}, str(tmp_path))
    cfg = load_config(str(tmp_path), {"LIBRARIAN_AGENT_TOKEN": "tok"})
    assert cfg is not None and cfg.timeout_ms == 15000


def test_config_schema_declares_token_as_env_secret() -> None:
    fields = {f["key"]: f for f in config_schema()}
    assert set(fields) == {"endpoint", "token", "agent_id", "project_key", "timeout_ms"}
    assert fields["token"]["secret"] is True
    assert fields["token"]["env_var"] == "LIBRARIAN_AGENT_TOKEN"
    assert fields["endpoint"]["required"] is True


def test_is_available_lazy_loads_from_hermes_home_env(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp"}, str(tmp_path))
    env = {"HERMES_HOME": str(tmp_path), "LIBRARIAN_AGENT_TOKEN": "tok"}
    assert LibrarianProvider(env=env).is_available() is True
    assert LibrarianProvider(env={"HERMES_HOME": str(tmp_path)}).is_available() is False


def test_is_available_falls_back_to_dot_hermes_under_home(tmp_path) -> None:
    hermes_home = tmp_path / ".hermes"
    save_config({"endpoint": "https://e/mcp"}, str(hermes_home))
    env = {"HOME": str(tmp_path), "LIBRARIAN_AGENT_TOKEN": "tok"}
    assert LibrarianProvider(env=env).is_available() is True


def test_initialize_wires_client_from_hermes_home_kwarg(tmp_path) -> None:
    save_config({"endpoint": "https://e/mcp"}, str(tmp_path))
    p = LibrarianProvider(env={"LIBRARIAN_AGENT_TOKEN": "tok"})
    p.initialize("sess-1", hermes_home=str(tmp_path), platform="cli")
    assert p._client is not None


def test_provider_save_config_delegates(tmp_path) -> None:
    LibrarianProvider(env={}).save_config({"endpoint": "https://e/mcp"}, str(tmp_path))
    assert (tmp_path / "librarian-plugin" / "config.json").exists()
