#!/usr/bin/env python3
"""ローカル git リポジトリのメトリクスを collect-metrics.ts 互換形式で集計する。

依存: Python 3.8+, git, gh（GitHub CLI）
出力: 累積メトリクスJSON。--activity-output でGitの日次活動JSONも出力可能。

使い方:
  python3 count-loc.py /path/to/repo
  python3 count-loc.py /path/to/repo --author-email user@example.com
  python3 count-loc.py /path/to/repo --author-name "Taro" --author-github "taro"
  python3 count-loc.py /path/to/repo --output result.json
  python3 count-loc.py /path/to/repo --offline --activity-output activity.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import date as date_type, datetime, timedelta, timezone
from functools import lru_cache
from math import ceil
from pathlib import Path, PurePosixPath
from urllib.parse import quote

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
    environment = dict(os.environ)
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"):
        environment.pop(key, None)
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, timeout=300, env=environment,
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


@lru_cache(maxsize=None)
def compile_gitattributes_pattern(pattern: str) -> re.Pattern[str]:
    """.gitattributes のパターンを git と同じ意味の正規表現へ変換する。

    [Workaround] PurePath.match は Python 3.12 以前で `**` を 1 階層の `*` として
    扱うため、`grpc/**/*.pb.go` が grpc/studio/src/foo.pb.go に一致しない。
    """
    pat = pattern.rstrip("/")
    # スラッシュを含まないパターンは任意の階層のファイル名に一致する
    if "/" not in pat:
        pat = f"**/{pat}"
    pat = pat.lstrip("/")

    out: list[str] = []
    index = 0
    while index < len(pat):
        if pat.startswith("**/", index):
            out.append("(?:[^/]+/)*")
            index += 3
        elif pat.startswith("**", index):
            out.append(".*")
            index += 2
        elif pat[index] == "*":
            out.append("[^/]*")
            index += 1
        elif pat[index] == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(pat[index]))
            index += 1

    # ディレクトリを指すパターンは配下のすべてに一致する
    return re.compile("^" + "".join(out) + "(?:/.*)?$")


def is_excluded(filepath: str, patterns: list[str]) -> bool:
    return any(compile_gitattributes_pattern(pat).match(filepath) for pat in patterns)


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


# --- 日次活動（Gitのみ、ネットワーク不要） ---

def shallow_boundary_date(repo: Path) -> str | None:
    """shallow 境界コミットのうち最も新しい作成日（JST）を返す。境界が無ければ None。"""
    path = Path(git(repo, "rev-parse", "--git-path", "shallow").strip())
    if not path.is_absolute():
        path = repo / path
    if not path.exists():
        return None
    jst = timezone(timedelta(hours=9))
    dates: list[str] = []
    for sha in path.read_text().split():
        timestamp = git(repo, "log", "-1", "--format=%aI", sha, check=False).strip()
        if timestamp:
            dates.append(
                datetime.fromisoformat(timestamp).astimezone(jst).date().isoformat()
            )
    return max(dates) if dates else None


def collect_daily_activity(
    repo: Path,
    ga_patterns: list[str],
    author_emails: list[str],
    author_names: list[str],
    ref: str = "HEAD",
    excluded_commits: list[str] | None = None,
    allow_shallow: bool = False,
) -> dict:
    # [Intended] shallow cloneでは過去の活動を0と誤認するため、完全な履歴を要求する。
    # --allow-shallow 指定時のみ、著者の活動が境界より後に始まることを確認して集計する。
    boundary: str | None = None
    if git(repo, "rev-parse", "--is-shallow-repository").strip() == "true":
        if not allow_shallow:
            raise RuntimeError("日次集計には完全なGit履歴が必要です。git fetch --unshallow を実行してください")
        boundary = shallow_boundary_date(repo)
    revision = git(repo, "rev-parse", "--verify", ref + "^{commit}").strip()
    author_flags: list[str] = []
    for value in author_emails + author_names:
        author_flags += ["--author", value]
    log = git(repo, "log", revision, "--no-merges", "--find-renames",
              "--numstat", "-z", "--format=%x1e%H%x09%aI",
              "--fixed-strings", *author_flags)
    days: dict[str, dict[str, int]] = {
        "changedLines": defaultdict(int), "commits": defaultdict(int),
    }
    jst = timezone(timedelta(hours=9))
    collected = datetime.now(timezone.utc)
    through = (collected.astimezone(jst).date() - timedelta(days=1)).isoformat()
    start = through
    seen: set[str] = set()
    excluded = set(excluded_commits or [])
    for entry in log.split("\x1e")[1:]:
        header, *records = entry.split("\0")
        sha, timestamp = header.strip().split("\t")
        if sha in seen:
            continue
        seen.add(sha)
        date = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(jst).date().isoformat()
        start = min(start, date)
        if sha in excluded:
            continue
        days["commits"][date] += 1
        index = 0
        while index < len(records):
            row = records[index].lstrip("\n")
            match = re.match(r"^(\d+|-)\t(\d+|-)\t(.*)$", row, re.S)
            if match:
                added, deleted, path = match.groups()
                if not path:
                    index += 2
                    path = records[index]
                if added != "-" and deleted != "-" and PurePosixPath(path).suffix.lower() in SOURCE_EXTS and not is_excluded(path, ga_patterns):
                    days["changedLines"][date] += int(added) + int(deleted)
            index += 1
    if boundary is not None:
        if start <= boundary:
            raise RuntimeError(
                f"shallow 境界（{boundary}）以前に著者の活動があるため日次集計できません。"
                "git fetch --unshallow を実行してください"
            )
        err(f"  shallow 境界 {boundary} より後の活動のみのため、切り詰められた履歴でも集計します")
    return {
        "version": 2,
        "collectedAt": collected.isoformat(),
        "startDate": start,
        "gitCacheKey": "",
        "metrics": {
            **{metric: {"days": dict(values), "completeFrom": start, "completeThrough": through}
               for metric, values in days.items()},
            # PR・CIはGitだけでは日次を復元できない。GitHubから取得できた場合は
            # collect_daily_github_activity() がこの未取得の値を置き換える。
            "mergedPRs": {"days": {}, "completeFrom": None, "completeThrough": None},
            "ciRuns": {"days": {}, "completeFrom": None, "completeThrough": None},
        },
    }


# --- 日次PR・CI（GitHub） ---

JST = timezone(timedelta(hours=9))

PR_SEARCH_QUERY = """query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { mergedAt } }
  }
}"""

# 検索APIが1クエリで返せる上限。超えた区間は分割して取得する。
SEARCH_RESULT_LIMIT = 1000


def add_days(day: str, offset: int) -> str:
    return (date_type.fromisoformat(day) + timedelta(days=offset)).isoformat()


def jst_date(timestamp: str) -> str:
    """イベントの実日時をJSTの日付に変換する。"""
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(JST).date().isoformat()


def read_previous_activity(path: Path) -> dict | None:
    """既存の日次活動JSONを読む。壊れている場合は未収集として扱う。"""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and data.get("version") == 2 else None


def previous_series(previous: dict | None, metric: str) -> dict:
    series = (previous or {}).get("metrics", {}).get(metric)
    if not isinstance(series, dict) or not isinstance(series.get("days"), dict):
        return {"days": {}, "completeFrom": None, "completeThrough": None}
    return series


def fetch_merged_pr_dates(repo_id: str, author: str | None, since: str, until: str) -> list[str]:
    """since〜until（JSTの日付）にマージされたPRのマージ日（JST）を列挙する。"""
    query = (
        f"repo:{repo_id} is:pr is:merged "
        f"merged:{since}T00:00:00+09:00..{until}T23:59:59+09:00"
    )
    if author:
        query += f" author:{author}"
    dates: list[str] = []
    after: str | None = None
    while True:
        argv = ["api", "graphql", "-f", f"query={PR_SEARCH_QUERY}", "-f", f"q={query}"]
        if after:
            argv += ["-f", f"after={after}"]
        search = json.loads(gh(*argv))["data"]["search"]
        # 検索APIは上限を超えると打ち切られるため、区間を分割して取り直す。
        if search["issueCount"] > SEARCH_RESULT_LIMIT:
            if since == until:
                raise RuntimeError(f"1日に{SEARCH_RESULT_LIMIT}件を超えるPRがあり、完全取得できません: {since}")
            span = (date_type.fromisoformat(until) - date_type.fromisoformat(since)).days
            middle = add_days(since, span // 2)
            return (
                fetch_merged_pr_dates(repo_id, author, since, middle)
                + fetch_merged_pr_dates(repo_id, author, add_days(middle, 1), until)
            )
        dates += [
            jst_date(node["mergedAt"])
            for node in search["nodes"]
            if node.get("mergedAt")
        ]
        if not search["pageInfo"]["hasNextPage"]:
            return dates
        after = search["pageInfo"]["endCursor"]


def fetch_workflow_runs(repo_id: str, actor: str | None, since: int, until: int) -> dict[int, str]:
    """since〜until（UTCのエポック秒）に作成されたCI実行を {id: 作成日時} で返す。"""
    owner, name = repo_id.split("/")
    created = f"{_utc_iso(since)}..{_utc_iso(until)}"
    endpoint = f"repos/{owner}/{name}/actions/runs?per_page=100&created={quote(created)}"
    if actor:
        endpoint += f"&actor={quote(actor)}"
    jq = "{total_count, runs: [.workflow_runs[] | {id, created_at}]}"
    first = json.loads(gh("api", f"{endpoint}&page=1", "--jq", jq))
    total = first["total_count"]
    # [Workaround] REST APIは1クエリ1000件までしか辿れないため、超える区間は秒単位で分割する。
    if total > SEARCH_RESULT_LIMIT:
        if since >= until:
            raise RuntimeError(f"同一秒に{SEARCH_RESULT_LIMIT}件を超えるCIがあり、完全取得できません")
        middle = (since + until) // 2
        return {
            **fetch_workflow_runs(repo_id, actor, since, middle),
            **fetch_workflow_runs(repo_id, actor, middle + 1, until),
        }
    runs = {run["id"]: run["created_at"] for run in first["runs"]}
    for page in range(2, ceil(total / 100) + 1):
        runs.update({
            run["id"]: run["created_at"]
            for run in json.loads(gh("api", f"{endpoint}&page={page}", "--jq", jq))["runs"]
        })
    if len(runs) != total:
        raise RuntimeError("CI取得中に件数が変化しました。次回再取得します")
    return runs


def _utc_iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day_bounds(since: str, until: str) -> tuple[int, int]:
    """JSTの日付範囲を、その範囲に対応するUTCエポック秒の開始・終了に変換する。"""
    start = datetime.fromisoformat(f"{since}T00:00:00+09:00")
    end = datetime.fromisoformat(f"{until}T23:59:59+09:00")
    return int(start.timestamp()), int(end.timestamp())


def collect_daily_github_activity(
    repo_id: str,
    author_githubs: list[str],
    start_date: str,
    through: str,
    today: str,
    previous: dict | None,
) -> dict[str, dict]:
    """PR・CIの日次実績をGitHubから取得する。前回の取得済み範囲より後だけを取り直す。"""
    authors: list[str | None] = [*sorted(set(author_githubs))] or [None]
    metrics: dict[str, dict] = {}

    for metric in ("mergedPRs", "ciRuns"):
        before = previous_series(previous, metric)
        since = add_days(before["completeThrough"], 1) if before["completeThrough"] else start_date
        if since > through:
            metrics[metric] = before
            continue
        # 取得し直す範囲より前の実績は、前回の値をそのまま引き継ぐ。
        days: dict[str, int] = {
            day: count for day, count in before["days"].items() if day < since
        }
        for author in authors:
            if metric == "mergedPRs":
                dates = fetch_merged_pr_dates(repo_id, author, since, through)
            else:
                runs = fetch_workflow_runs(repo_id, author, *_day_bounds(since, through))
                dates = [jst_date(created) for created in runs.values()]
            for day in dates:
                if since <= day <= through:
                    days[day] = days.get(day, 0) + 1
        metrics[metric] = {
            "days": days,
            # [Intended] 削除されたCI実行は復元できない。初回取得より前は下限値でしかないため、
            # 完全な期間は初回取得日からとして0との区別を残す。PRはマージ日で遡って取得できる。
            "completeFrom": before["completeFrom"] or (start_date if metric == "mergedPRs" else today),
            "completeThrough": through,
        }
    return metrics


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
    parser.add_argument("--activity-output",
                        help="日次活動JSONの出力先（Portalのsrc/data/activity-repositories/へコピー）")
    parser.add_argument("--ref", default="HEAD",
                        help="日次集計するブランチまたはコミット（デフォルト: HEAD）")
    parser.add_argument("--exclude-commit", action="append", default=[],
                        help="日次集計から除外する初期投入などの完全なコミットSHA（複数可）")
    parser.add_argument("--allow-shallow", action="store_true",
                        help="shallow clone でも、著者の活動が境界より後に始まる場合は日次集計する")
    parser.add_argument("--offline", action="store_true",
                        help="GitHubにアクセスせずGitだけを集計する")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[0-9a-f]{40}", sha) for sha in args.exclude_commit):
        parser.error("--exclude-commit には40文字のコミットSHAを指定してください")

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
    if repo_id and not args.offline:
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
        err("GitHub 集計をスキップします（日次データのPR・CIは未取得）")

    if args.activity_output:
        activity = collect_daily_activity(
            repo, ga_patterns, args.author_email, args.author_name,
            args.ref, args.exclude_commit, args.allow_shallow,
        )
        activity_path = Path(args.activity_output).resolve()
        previous_activity = read_previous_activity(activity_path)
        if repo_id and not args.offline:
            err("日次のPR・CI数を集計中...")
            try:
                activity["metrics"].update(collect_daily_github_activity(
                    repo_id, args.author_github, activity["startDate"],
                    activity["metrics"]["commits"]["completeThrough"],
                    datetime.now(JST).date().isoformat(), previous_activity,
                ))
                for metric in ("mergedPRs", "ciRuns"):
                    series = activity["metrics"][metric]
                    err(f"  {metric}: {len(series['days'])}日 / 計{sum(series['days'].values())}件")
            except Exception as e:
                err(f"  Warning: 日次のPR・CI数の取得に失敗しました: {e}")
        # 取得できなかった場合も、前回までに取得済みの日次実績は捨てずに引き継ぐ。
        for metric in ("mergedPRs", "ciRuns"):
            if activity["metrics"][metric]["completeThrough"] is None:
                activity["metrics"][metric] = previous_series(previous_activity, metric)
        activity_path.parent.mkdir(parents=True, exist_ok=True)
        activity_path.write_text(json.dumps(activity, indent=2, ensure_ascii=False) + "\n")
        err(f"日次活動を書き出しました: {activity_path}")

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
