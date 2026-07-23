#!/usr/bin/env python3
"""ローカル git リポジトリのメトリクスを collect-metrics.ts 互換形式で集計する。

依存: Python 3.8+, git, gh（GitHub CLI）
出力: PerRepoFileData 形式の JSON（src/data/repositories/*.json と同一スキーマ）

使い方:
  python3 count-loc.py /path/to/repo
  python3 count-loc.py /path/to/repo --author-email user@example.com
  python3 count-loc.py /path/to/repo --author-name "Taro" --author-github "taro"
  python3 count-loc.py /path/to/repo --output result.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SOURCE_EXTS: set[str] = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".java", ".kt", ".kts", ".swift", ".go", ".rs",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh",
    ".cs", ".rb", ".php", ".dart", ".scala",
    ".sh", ".bash", ".zsh", ".lua", ".r",
    ".hs", ".ex", ".exs", ".clj", ".cljs", ".cljc",
    ".zig", ".nim", ".ml", ".mli", ".fs", ".fsi", ".fsx",
    ".jl", ".pl", ".pm", ".erl",
    ".astro", ".vue", ".svelte",
}

GITATTRIBUTES_MARKERS = {
    "linguist-generated", "linguist-generated=true",
    "linguist-vendored", "linguist-vendored=true",
}


def err(msg: str) -> None:
    print(msg, file=sys.stderr)


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, timeout=300,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def gh(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["gh", *args],
        capture_output=True, text=True, timeout=120,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


# --- .gitattributes ---

def parse_gitattributes(repo: Path) -> list[str]:
    path = repo / ".gitattributes"
    if not path.exists():
        return []
    patterns: list[str] = []
    for line in path.read_text(errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        if set(parts[1:]) & GITATTRIBUTES_MARKERS:
            patterns.append(parts[0])
    return patterns


def is_excluded(filepath: str, patterns: list[str]) -> bool:
    p = PurePosixPath(filepath)
    return any(p.match(pat) for pat in patterns)


# --- git log --numstat ---

def count_numstat(
    repo: Path,
    ga_patterns: list[str],
    author_emails: list[str],
    author_names: list[str],
) -> tuple[int, int, dict[str, int]]:
    author_flags: list[str] = []
    for e in author_emails:
        author_flags += ["--author", e]
    for n in author_names:
        author_flags += ["--author", n]

    out = git(
        repo, "log", "--numstat", "--format=", "--no-renames", "--fixed-strings",
        *author_flags,
        check=False,
    )

    added_total = 0
    deleted_total = 0
    ext_lines: dict[str, int] = defaultdict(int)

    for line in out.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split("\t")
        if len(parts) < 3:
            continue
        added_str, deleted_str, filepath = parts[0], parts[1], parts[2]
        if added_str == "-" or deleted_str == "-":
            continue
        if is_excluded(filepath, ga_patterns):
            continue
        ext = PurePosixPath(filepath).suffix.lower()
        if ext not in SOURCE_EXTS:
            continue
        try:
            added = int(added_str)
            deleted = int(deleted_str)
        except ValueError:
            continue
        added_total += added
        deleted_total += deleted
        ext_lines[ext] += added

    return added_total, deleted_total, dict(ext_lines)


# --- commits ---

def count_commits(
    repo: Path,
    author_emails: list[str],
    author_names: list[str],
) -> int:
    author_flags: list[str] = []
    for e in author_emails:
        author_flags += ["--author", e]
    for n in author_names:
        author_flags += ["--author", n]
    out = git(
        repo, "rev-list", "--count", "--fixed-strings", "HEAD", *author_flags,
    )
    return int(out.strip())


# --- merged PRs (gh api graphql) ---

def detect_github_repo_id(repo: Path) -> str | None:
    import re
    try:
        url = git(repo, "remote", "get-url", "origin", check=False).strip()
    except RuntimeError:
        return None
    m = re.search(r"github\.com[:/]([a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+?)(?:\.git)?$", url)
    return m.group(1) if m else None


def count_merged_prs_total(repo_id: str) -> int:
    owner, name = repo_id.split("/")
    query = f'query {{ repository(owner:"{owner}", name:"{name}") {{ pullRequests(states:MERGED) {{ totalCount }} }} }}'
    out = gh(
        "api", "graphql", "-f", f"query={query}",
        "--jq", ".data.repository.pullRequests.totalCount",
    )
    return int(out.strip())


def count_merged_prs_by_author(repo_id: str, author_github: str) -> int:
    query = f'query {{ search(query:"repo:{repo_id} is:pr is:merged author:{author_github}", type:ISSUE) {{ issueCount }} }}'
    out = gh(
        "api", "graphql", "-f", f"query={query}",
        "--jq", ".data.search.issueCount",
    )
    return int(out.strip())


def count_merged_prs(repo_id: str, author_githubs: list[str]) -> int:
    if not author_githubs:
        return count_merged_prs_total(repo_id)
    total = 0
    for author in set(author_githubs):
        total += count_merged_prs_by_author(repo_id, author)
    return total


# --- CI runs (GraphQL totalCount) ---

def _count_workflow_runs_graphql(
    owner: str, name: str, actor: str | None,
) -> int:
    """REST API /actions/runs の totalCount を利用して全件数を取得する。"""
    endpoint = f"repos/{owner}/{name}/actions/runs?per_page=1"
    if actor:
        endpoint += f"&actor={actor}"
    out = gh("api", endpoint, "--jq", ".total_count", check=False)
    stripped = out.strip()
    if not stripped:
        return 0
    return int(stripped)


def count_ci_runs(repo_id: str, author_githubs: list[str]) -> int:
    owner, name = repo_id.split("/")
    if not author_githubs:
        return _count_workflow_runs_graphql(owner, name, None)
    seen_total = 0
    for actor in set(author_githubs):
        seen_total += _count_workflow_runs_graphql(owner, name, actor)
    return seen_total


# --- main ---

def main() -> None:
    parser = argparse.ArgumentParser(
        description="ローカル git リポジトリのメトリクスを collect-metrics.ts 互換形式で集計する",
    )
    parser.add_argument("target", nargs="?", default=".",
                        help="対象リポジトリのパス（デフォルト: カレントディレクトリ）")
    parser.add_argument("--author-email", action="append", default=[],
                        help="著者メールアドレス（git log --author 用、複数指定可）")
    parser.add_argument("--author-name", action="append", default=[],
                        help="著者名（git log --author 用、複数指定可）")
    parser.add_argument("--author-github", action="append", default=[],
                        help="GitHub ユーザー名（PR・CI カウント用、複数指定可）")
    parser.add_argument("--output", "-o",
                        help="出力先ファイルパス（省略時は stdout）")
    args = parser.parse_args()

    repo = Path(args.target).resolve()
    if not repo.is_dir():
        err(f"エラー: ディレクトリが見つかりません: {repo}")
        sys.exit(1)
    if not (repo / ".git").exists():
        err(f"エラー: git リポジトリではありません: {repo}")
        sys.exit(1)

    ga_patterns = parse_gitattributes(repo)

    # addedLines / deletedLines / extLines
    err("git log --numstat を集計中...")
    added, deleted, ext_lines = count_numstat(
        repo, ga_patterns, args.author_email, args.author_name,
    )
    err(f"  added={added}, deleted={deleted}")

    # commits
    err("コミット数を集計中...")
    commits = count_commits(repo, args.author_email, args.author_name)
    err(f"  commits={commits}")

    # merged PRs / CI runs (GitHub)
    merged_prs = 0
    ci_runs = 0
    repo_id = detect_github_repo_id(repo)
    if repo_id:
        err(f"GitHub リポジトリを検出: {repo_id}")

        err("マージ済み PR 数を集計中...")
        try:
            merged_prs = count_merged_prs(repo_id, args.author_github)
            err(f"  mergedPRs={merged_prs}")
        except Exception as e:
            err(f"  Warning: PR 数の取得に失敗しました: {e}")

        err("CI 実行数を集計中...")
        try:
            ci_runs = count_ci_runs(repo_id, args.author_github)
            err(f"  ciRuns={ci_runs}")
        except Exception as e:
            err(f"  Warning: CI 実行数の取得に失敗しました: {e}")
    else:
        err("GitHub リモートが見つかりません。PR・CI の集計をスキップします")

    result = {
        "cacheKey": "",
        "addedLines": added,
        "deletedLines": deleted,
        "commits": commits,
        "mergedPRs": merged_prs,
        "ciRuns": ci_runs,
        "extLines": ext_lines,
        "collectedAt": datetime.now(timezone.utc).isoformat(),
    }

    output = json.dumps(result, indent=2, ensure_ascii=False) + "\n"

    if args.output:
        out_path = Path(args.output).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output)
        err(f"Written to {out_path}")
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main()
