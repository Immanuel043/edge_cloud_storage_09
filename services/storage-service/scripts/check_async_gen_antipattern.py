#!/usr/bin/env python3
"""CI lint: streaming-response generator antipattern detector.

Reports async generators (functions with `yield`) that contain `async with`
or `await` in `try ... finally`. These cause
`RuntimeError: aclose(): asynchronous generator is already running` when
the generator is closed mid-stream (client disconnect during streaming
response).

The check is deliberately scoped to streaming-response generators. FastAPI
dependency-injection idioms (`async def get_db(): async with AsyncSessionLocal() as s: yield s`)
and `@asynccontextmanager` lifespan handlers are NOT subject to the race —
they are entered/exited by FastAPI itself, not by client-cancelled
streaming code. The script applies allowlists to skip them.

Allowlist mechanisms:

1. Decorator allowlist — functions decorated with `@asynccontextmanager`
   are skipped (intentional context-manager generators).
2. Name allowlist — well-known FastAPI dep names: `get_db`, `get_redis`,
   `lifespan`, plus glob `get_*_session`. Configurable via
   `services/storage-service/.async_gen_lint_allowlist.txt` (one name
   pattern per line, supports `*` glob).
3. File allowlist — paths matching `**/dependencies.py`,
   `**/database.py`, or `**/main.py`.
4. Per-line escape hatch — `# noqa: ASYNC_GEN_RACE` on the offending line
   suppresses the violation.

Usage:
    python check_async_gen_antipattern.py [--allowlist PATH] [--paths DIR ...]

Exits 0 if no violations, 1 with a list otherwise. Intended to be wired
into CI as a hard-fail step.
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import os
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

DEFAULT_NAME_ALLOWLIST = (
    "get_db",
    "get_redis",
    "get_es_client",
    "get_*_session",
    "lifespan",
)
DEFAULT_FILE_PATTERNS = (
    "**/dependencies.py",
    "**/database.py",
    "**/main.py",
)
PRAGMA = "noqa: ASYNC_GEN_RACE"


def load_allowlist(path: Path) -> Tuple[List[str], List[str]]:
    """Read allowlist file. Returns (name_patterns, file_patterns)."""
    names = list(DEFAULT_NAME_ALLOWLIST)
    files = list(DEFAULT_FILE_PATTERNS)
    if not path.exists():
        return names, files
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("file:"):
            files.append(line[len("file:"):].strip())
        else:
            names.append(line)
    return names, files


def _has_yield(node: ast.AST) -> bool:
    """True if `node` (a function body) contains a `yield`/`yield from`
    that is NOT inside a nested function definition."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.FunctionDef) or isinstance(sub, ast.AsyncFunctionDef):
            # Don't recurse into nested defs — those are checked separately
            if sub is not node:
                continue
        if isinstance(sub, (ast.Yield, ast.YieldFrom)):
            return True
    return False


def _name_allowed(name: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def _file_allowed(path: Path, patterns: Iterable[str]) -> bool:
    s = str(path)
    return any(fnmatch.fnmatch(s, p) for p in patterns)


def _decorated_with_asynccontextmanager(func: ast.AsyncFunctionDef) -> bool:
    for dec in func.decorator_list:
        # @asynccontextmanager  or  @contextlib.asynccontextmanager
        if isinstance(dec, ast.Name) and dec.id == "asynccontextmanager":
            return True
        if isinstance(dec, ast.Attribute) and dec.attr == "asynccontextmanager":
            return True
    return False


def _scan_function(
    func: ast.AsyncFunctionDef, src_lines: List[str]
) -> List[Tuple[int, str]]:
    """Return list of (lineno, kind) violations within `func`'s direct body."""
    violations: List[Tuple[int, str]] = []
    for sub in ast.walk(func):
        # Don't descend into nested function defs
        if (
            isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef))
            and sub is not func
        ):
            # Skip the nested def's contents; they are scanned independently
            for inner in ast.walk(sub):
                pass  # no-op; we just want to mark sub as visited
            # Replace ast.walk's recursion: continue here in the outer loop
            continue
    # Re-implement scan without ast.walk-into-nested by manual recursion
    def _walk_skip_nested(n):
        for child in ast.iter_child_nodes(n):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            yield child
            yield from _walk_skip_nested(child)

    for sub in _walk_skip_nested(func):
        if isinstance(sub, ast.AsyncWith):
            line = src_lines[sub.lineno - 1] if sub.lineno - 1 < len(src_lines) else ""
            if PRAGMA not in line:
                violations.append((sub.lineno, "async with"))
        elif isinstance(sub, ast.Try) and sub.finalbody:
            for fnode in sub.finalbody:
                for inner in ast.walk(fnode):
                    if isinstance(inner, ast.Await):
                        line = (
                            src_lines[sub.lineno - 1]
                            if sub.lineno - 1 < len(src_lines)
                            else ""
                        )
                        if PRAGMA not in line:
                            violations.append((sub.lineno, "await in finally"))
                        break
                else:
                    continue
                break
    return violations


def scan_file(
    path: Path, name_patterns: List[str], file_patterns: List[str]
) -> List[Tuple[Path, int, str, str]]:
    """Return list of (path, lineno, function_name, kind) violations."""
    if _file_allowed(path, file_patterns):
        return []
    try:
        src = path.read_text()
    except (OSError, UnicodeDecodeError):
        return []
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError:
        return []
    src_lines = src.splitlines()
    out: List[Tuple[Path, int, str, str]] = []
    # Walk all async functions, including nested ones — each is its own scope
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        if _name_allowed(node.name, name_patterns):
            continue
        if _decorated_with_asynccontextmanager(node):
            continue
        if not _has_yield(node):
            continue
        for lineno, kind in _scan_function(node, src_lines):
            out.append((path, lineno, node.name, kind))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--allowlist",
        default=str(
            Path(__file__).parent.parent / ".async_gen_lint_allowlist.txt"
        ),
        help="Path to allowlist file (one pattern per line)",
    )
    parser.add_argument(
        "--paths",
        nargs="+",
        default=[
            "services/storage-service/app",
            "services/zk-encryption-service/app",
        ],
        help="Directories to scan",
    )
    args = parser.parse_args()

    name_patterns, file_patterns = load_allowlist(Path(args.allowlist))

    violations: List[Tuple[Path, int, str, str]] = []
    for root in args.paths:
        for dirpath, _dirnames, filenames in os.walk(root):
            if "__pycache__" in dirpath or "/venv/" in dirpath or "/.git/" in dirpath:
                continue
            for fn in filenames:
                if not fn.endswith(".py"):
                    continue
                p = Path(dirpath) / fn
                violations.extend(scan_file(p, name_patterns, file_patterns))

    if not violations:
        print("OK: no streaming-response generator antipattern violations")
        return 0

    print(f"FAIL: {len(violations)} violation(s) found:\n")
    for path, lineno, fname, kind in sorted(violations):
        print(f"  {path}:{lineno} async def {fname}() — {kind}")
    print(
        "\nSee CLAUDE.md → 'Async generator rules' for the rule and remediation patterns."
    )
    print(
        "Per-site escape hatch: add `# noqa: ASYNC_GEN_RACE` to the offending line "
        "with a justification comment."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
