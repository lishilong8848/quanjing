#!/usr/bin/env python3
"""Helpers for loading local environment configuration."""

from __future__ import annotations

import os
import re
from pathlib import Path


ENV_PATTERN = re.compile(
    r"""^\s*\$env:(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<quote>['"])(?P<value>.*)(?P=quote)\s*$"""
)
ASSIGN_PATTERN = re.compile(
    r"""^\s*\$env:(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<value>.+?)\s*$"""
)
CHAR_EXPR_PATTERN = re.compile(
    r"""^\s*(?:\(\s*)?\[char\]0x(?P<value>[0-9A-Fa-f]+)(?:\s*\))?\s*$"""
)


def default_env_file() -> Path:
    configured = os.getenv("FEISHU_ENV_FILE", "").strip()
    if configured:
        return resolve_project_path(configured)
    return project_root() / "config" / "set_env.ps1"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_project_path(
    path_value: str | os.PathLike[str],
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> Path:
    path = Path(os.path.expandvars(os.fspath(path_value)))
    if path.is_absolute():
        return path.resolve()
    anchor = Path(base_dir) if base_dir else project_root()
    return (anchor / path).resolve()


def load_local_env_file(
    env_file: str | os.PathLike[str] | None = None,
    *,
    override: bool = False,
) -> Path | None:
    """Loads simple `$env:NAME = "value"` assignments from a local PowerShell file."""

    path = resolve_project_path(env_file) if env_file else default_env_file()
    if not path.exists():
        return None

    for line in path.read_text(encoding="utf-8").splitlines():
        match = ASSIGN_PATTERN.match(line)
        if not match:
            continue
        name = match.group("name")
        value = _parse_env_value(match.group("value"))
        if value is None:
            continue
        if override or name not in os.environ:
            os.environ[name] = value
    return path


def _parse_env_value(raw_value: str) -> str | None:
    quoted_match = re.fullmatch(r"""(?P<quote>['"])(?P<value>.*)(?P=quote)""", raw_value.strip())
    if quoted_match:
        return quoted_match.group("value")

    parts = [part.strip() for part in raw_value.split("+")]
    if not parts:
        return None

    chars: list[str] = []
    for part in parts:
        match = CHAR_EXPR_PATTERN.match(part)
        if not match:
            return None
        chars.append(chr(int(match.group("value"), 16)))
    return "".join(chars)
