import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
	ACTIVITY_METRICS,
	addDays,
	buildActivityData,
	isCalendarDate,
	type MetricSeries,
	type RepositoryActivity,
	toActivityDate,
} from "../src/utils/activity.ts";
import {
	type AuthorConfig,
	detectGitHubRepoId,
	getExcludedPatterns,
	isExcluded,
	loadConfig,
	type RepoConfig,
	repoToFilePath,
	SOURCE_EXTS,
} from "./collect-metrics.ts";

const execute = promisify(execFile);
async function exec(
	command: string,
	args: string[],
	options: { cwd?: string; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_PREFIX",
	])
		delete environment[key];
	return execute(command, args, {
		...options,
		encoding: "utf8",
		env: environment,
	});
}
const MAX_BUFFER = 64 * 1024 * 1024;
export type Api = <T>(endpoint: string, jq?: string) => Promise<T>;
const api: Api = async <T>(endpoint: string, jq?: string): Promise<T> => {
	const { stdout } = await exec(
		"gh",
		["api", endpoint, ...(jq ? ["--jq", jq] : [])],
		{ maxBuffer: MAX_BUFFER },
	);
	return JSON.parse(stdout) as T;
};
export const emptySeries = (): MetricSeries => ({
	days: {},
	completeFrom: null,
	completeThrough: null,
});

function increment(
	days: Record<string, number>,
	date: string,
	value: number,
): void {
	days[date] = (days[date] ?? 0) + value;
}

/** -z形式のnumstatを読み、リネームの旧・新パスもNUL区切りで扱う。 */
export function parseGitActivity(
	log: string,
	excludedPatterns: string[],
	excludedCommits: string[] = [],
): {
	changedLines: Record<string, number>;
	commits: Record<string, number>;
	startDate: string | null;
} {
	const changedLines: Record<string, number> = {};
	const commits: Record<string, number> = {};
	let startDate: string | null = null;
	const seen = new Set<string>();
	for (const entry of log.split("\x1e").slice(1)) {
		const [header, ...records] = entry.split("\0");
		const [hash, timestamp] = header.trim().split("\t");
		if (!hash || !timestamp || seen.has(hash)) continue;
		seen.add(hash);
		const date = toActivityDate(timestamp);
		if (!startDate || date < startDate) startDate = date;
		if (excludedCommits.includes(hash)) continue;
		increment(commits, date, 1);
		for (let index = 0; index < records.length; index++) {
			const row = records[index].replace(/^\n/, "");
			const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(row);
			if (!match) continue;
			let file = match[3];
			if (file === "") {
				index += 2;
				file = records[index];
				if (!file) throw new Error("リネーム情報が不正です");
			}
			if (match[1] === "-" || match[2] === "-") continue;
			if (
				!SOURCE_EXTS.has(extname(file).toLowerCase()) ||
				isExcluded(file, excludedPatterns)
			)
				continue;
			increment(changedLines, date, Number(match[1]) + Number(match[2]));
		}
	}
	return { changedLines, commits, startDate };
}

interface Pull {
	number: number;
	merged_at: string | null;
	updated_at: string;
	login: string | null;
}
interface Run {
	id: number;
	created_at: string;
	login: string | null;
}
interface RunsPage {
	total_count: number;
	runs: Run[];
}

const authorMatches = (login: string | null, authors: string[]): boolean =>
	authors.length === 0 ||
	(login !== null &&
		authors.some((author) => author.toLowerCase() === login.toLowerCase()));

const dayStart = (date: string): string =>
	new Date(date + "T00:00:00+09:00").toISOString();
const dayEnd = (date: string): string =>
	new Date(Date.parse(dayStart(addDays(date, 1))) - 1000).toISOString();
function prefixDays(
	previous: MetricSeries | undefined,
	from: string,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(previous?.days ?? {}).filter(([date]) => date < from),
	);
}

export async function collectPulls(
	request: Api,
	repo: string,
	authors: string[],
	startDate: string,
	through: string,
	previous?: MetricSeries,
): Promise<MetricSeries> {
	const from = previous?.completeThrough
		? addDays(previous.completeThrough, 1)
		: startDate;
	if (from > through && previous) return previous;
	const days = prefixDays(previous, from);
	const seen = new Set<number>();
	for (let page = 1; ; page++) {
		const pulls = await request<Pull[]>(
			`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
			"[.[] | {number, merged_at, updated_at, login: .user.login}]",
		);
		if (!Array.isArray(pulls)) throw new Error("PRレスポンスが不正です");
		for (const pull of pulls) {
			if (
				!pull.merged_at ||
				seen.has(pull.number) ||
				!authorMatches(pull.login, authors)
			)
				continue;
			seen.add(pull.number);
			const date = toActivityDate(pull.merged_at);
			if (date >= from && date <= through) increment(days, date, 1);
		}
		const oldest = pulls.at(-1)?.updated_at;
		if (
			pulls.length < 100 ||
			(oldest && Date.parse(oldest) < Date.parse(dayStart(from)))
		)
			break;
	}
	return {
		days,
		completeFrom: previous?.completeFrom ?? startDate,
		completeThrough: through,
	};
}

/** created検索の1000件上限を超えた区間は秒単位まで分割し、境界の重複を防ぐ。 */
export async function fetchRuns(
	request: Api,
	repo: string,
	from: string,
	to: string,
): Promise<Run[]> {
	const endpoint = (page: number) =>
		`repos/${repo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent(from + ".." + to)}`;
	const query =
		"{total_count, runs: [.workflow_runs[] | {id, created_at, login: .actor.login}]}";
	const first = await request<RunsPage>(endpoint(1), query);
	if (!Number.isInteger(first.total_count) || !Array.isArray(first.runs))
		throw new Error("CIレスポンスが不正です");
	if (first.total_count > 1000) {
		const start = Math.floor(Date.parse(from) / 1000);
		const end = Math.floor(Date.parse(to) / 1000);
		if (start >= end)
			throw new Error("同一秒に1000件を超えるCIがあり、完全取得できません");
		const middle = Math.floor((start + end) / 2);
		const left = await fetchRuns(
			request,
			repo,
			from,
			new Date(middle * 1000).toISOString(),
		);
		const right = await fetchRuns(
			request,
			repo,
			new Date((middle + 1) * 1000).toISOString(),
			to,
		);
		return [
			...new Map([...left, ...right].map((run) => [run.id, run])).values(),
		];
	}
	const runs = [...first.runs];
	for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
		const next = await request<RunsPage>(endpoint(page), query);
		runs.push(...next.runs);
	}
	const unique = [...new Map(runs.map((run) => [run.id, run])).values()];
	if (unique.length !== first.total_count)
		throw new Error("CI取得中に件数が変化しました。次回再取得します");
	return unique;
}

export async function collectRuns(
	request: Api,
	repo: string,
	authors: string[],
	startDate: string,
	through: string,
	today: string,
	previous?: MetricSeries,
): Promise<MetricSeries> {
	const from = previous?.completeThrough
		? addDays(previous.completeThrough, 1)
		: startDate;
	if (from > through && previous) return previous;
	const days = prefixDays(previous, from);
	const runs = await fetchRuns(request, repo, dayStart(from), dayEnd(through));
	for (const run of runs) {
		const date = toActivityDate(run.created_at);
		if (date >= from && date <= through && authorMatches(run.login, authors))
			increment(days, date, 1);
	}
	// [Intended] 過去に削除されたrunは復元できない。初回取得前は下限値として残し、完全な0と区別する。
	return {
		days,
		completeFrom: previous?.completeFrom ?? today,
		completeThrough: through,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRepositoryActivity(
	path: string,
): RepositoryActivity | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isRecord(data) ||
			data.version !== 2 ||
			typeof data.startDate !== "string" ||
			!isCalendarDate(data.startDate) ||
			typeof data.collectedAt !== "string" ||
			!Number.isFinite(Date.parse(data.collectedAt)) ||
			typeof data.gitCacheKey !== "string" ||
			!isRecord(data.metrics)
		)
			return undefined;
		for (const metric of ACTIVITY_METRICS) {
			const series = data.metrics[metric];
			if (!isRecord(series) || !isRecord(series.days)) return undefined;
			for (const key of ["completeFrom", "completeThrough"]) {
				if (
					series[key] !== null &&
					(typeof series[key] !== "string" || !isCalendarDate(series[key]))
				)
					return undefined;
			}
			if (
				Object.entries(series.days).some(
					([date, value]) =>
						!isCalendarDate(date) ||
						typeof value !== "number" ||
						!Number.isSafeInteger(value) ||
						value < 0,
				)
			)
				return undefined;
		}
		return data as unknown as RepositoryActivity;
	} catch {
		return undefined;
	}
}

async function collectRepository(
	config: RepoConfig,
	author: AuthorConfig | undefined,
	salt: string,
	collectedAt: string,
	previous: RepositoryActivity | undefined,
): Promise<RepositoryActivity> {
	const repo =
		config.repo === "self" ? detectGitHubRepoId(process.cwd()) : config.repo;
	if (!repo) throw new Error("集計元のGitHubリポジトリを判定できません");
	const today = toActivityDate(collectedAt);
	const through = addDays(today, -1);
	const meta = await api<{ created_at: string; default_branch: string }>(
		`repos/${repo}`,
		"{created_at, default_branch}",
	);
	const head = await api<{ sha: string }>(
		`repos/${repo}/commits/${encodeURIComponent(meta.default_branch)}`,
		"{sha}",
	);
	const scope = JSON.stringify({
		version: 2,
		repo,
		author,
		excluded: config.activityExcludeCommits ?? [],
	});
	const scopeKey = createHmac("sha256", salt).update(scope).digest("hex");
	const gitCacheKey = createHmac("sha256", salt)
		.update(scope + head.sha)
		.digest("hex");
	// 集計範囲が変わった場合はPR・CIのアーカイブも再計算する。
	const compatible = previous?.gitCacheKey.startsWith(scopeKey + ":")
		? previous
		: undefined;
	const cached = compatible;
	const record: RepositoryActivity = cached
		? structuredClone(cached)
		: {
				version: 2,
				collectedAt,
				startDate: toActivityDate(meta.created_at),
				gitCacheKey: "",
				metrics: {
					changedLines: emptySeries(),
					commits: emptySeries(),
					mergedPRs: emptySeries(),
					ciRuns: emptySeries(),
				},
			};
	if (!cached || cached.gitCacheKey !== scopeKey + ":" + gitCacheKey) {
		const directory = mkdtempSync(join(tmpdir(), "portal-daily-"));
		try {
			await exec(
				"gh",
				[
					"repo",
					"clone",
					repo,
					directory,
					"--",
					"--single-branch",
					"--branch",
					meta.default_branch,
				],
				{ maxBuffer: MAX_BUFFER },
			);
			const { stdout: actualHead } = await exec("git", ["rev-parse", "HEAD"], {
				cwd: directory,
			});
			const { stdout } = await exec(
				"git",
				[
					"log",
					"HEAD",
					"--no-merges",
					"--find-renames",
					"--numstat",
					"-z",
					"--format=%x1e%H%x09%aI",
					"--fixed-strings",
					...(author?.emails ?? []).flatMap((value) => ["--author", value]),
					...(author?.names ?? []).flatMap((value) => ["--author", value]),
				],
				{ cwd: directory, maxBuffer: MAX_BUFFER },
			);
			const git = parseGitActivity(
				stdout,
				getExcludedPatterns(directory),
				config.activityExcludeCommits,
			);
			if (git.startDate && git.startDate < record.startDate)
				record.startDate = git.startDate;
			record.metrics.changedLines = {
				days: git.changedLines,
				completeFrom: record.startDate,
				completeThrough: through,
			};
			record.metrics.commits = {
				days: git.commits,
				completeFrom: record.startDate,
				completeThrough: through,
			};
			record.gitCacheKey =
				scopeKey +
				":" +
				createHmac("sha256", salt)
					.update(scope + actualHead.trim())
					.digest("hex");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	} else {
		record.metrics.changedLines.completeThrough = through;
		record.metrics.commits.completeThrough = through;
	}
	const authors = author?.github ?? [];
	for (const metric of ["mergedPRs", "ciRuns"] as const) {
		try {
			record.metrics[metric] =
				metric === "mergedPRs"
					? await collectPulls(
							api,
							repo,
							authors,
							record.startDate,
							through,
							cached?.metrics[metric],
						)
					: await collectRuns(
							api,
							repo,
							authors,
							record.startDate,
							through,
							today,
							cached?.metrics[metric],
						);
		} catch {
			// [Intended] API失敗を0で保存しない。過去のアーカイブを維持し、未取得期間は集計時に明示する。
			if (compatible) record.metrics[metric] = compatible.metrics[metric];
			console.error(
				`[${config.alias ?? config.repo}] ${metric}: 取得未完了。確認済みの履歴を維持します`,
			);
		}
	}
	record.collectedAt = collectedAt;
	return record;
}

export async function generateActivity(
	options: { output?: string; aggregateOnly?: boolean } = {},
): Promise<void> {
	const config = loadConfig();
	const collectedAt = new Date().toISOString();
	const salt =
		config.salt ?? process.env.PORTAL_SALT ?? randomBytes(32).toString("hex");
	const records: RepositoryActivity[] = [];
	const outputDir = resolve("src/data/activity-repositories");
	const used = new Set<string>();
	const sourceRepositories = new Set<string>();
	for (const repo of config.repositories) {
		const source = (
			repo.repo === "self" ? detectGitHubRepoId(process.cwd()) : repo.repo
		)?.toLowerCase();
		if (!source || sourceRepositories.has(source))
			throw new Error("集計元が不明または重複しています");
		sourceRepositories.add(source);
		const relativePath = relative(
			resolve("src/data/repositories"),
			repoToFilePath(repo),
		);
		if (used.has(relativePath))
			throw new Error("日次データの保存先が重複しています");
		used.add(relativePath);
		const path = resolve(outputDir, relativePath);
		console.error(`[${repo.alias ?? repo.repo}] 日次履歴を収集中`);
		const previous = readRepositoryActivity(path);
		if (options.aggregateOnly && !previous)
			throw new Error(
				"未収集のリポジトリがあります。先に通常の収集を実行してください",
			);
		const record =
			options.aggregateOnly && previous
				? previous
				: await collectRepository(
						repo,
						config.author,
						salt,
						collectedAt,
						previous,
					);
		if (!options.aggregateOnly) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(record, null, "\t") + "\n");
		}
		records.push(record);
	}
	const imports = resolve("src/data/activity-imports");
	if (existsSync(imports)) {
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!entry.name.endsWith(".json")) continue;
				const identity = relative(imports, path);
				if (used.has(identity))
					throw new Error(
						"オンライン収集とローカル取り込みの保存名が重複しています",
					);
				const record = readRepositoryActivity(path);
				if (!record) throw new Error("ローカル日次データの形式が不正です");
				used.add(identity);
				records.push(record);
			}
		};
		walk(imports);
	}
	// 設定に含まれるリポジトリと明示的に取り込んだローカル日次データを合算する。
	// [Intended] 合算だけでは観測日を進めず、実際に収集した日次データの日時を使う。
	const latestCollection = records.reduce<string | null>(
		(latest, record) =>
			!latest || Date.parse(record.collectedAt) > Date.parse(latest)
				? record.collectedAt
				: latest,
		null,
	);
	if (!latestCollection) throw new Error("収集済みの日次データがありません");
	const data = buildActivityData(records, latestCollection);
	const output = resolve(options.output ?? "src/data/activity.json");
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(data, null, "\t") + "\n");
	console.log(
		`日次データを生成しました: ${records.length}リポジトリ / ${data.daily.length}日`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((arg) => arg !== "--"),
		options: {
			output: { type: "string" },
			"aggregate-only": { type: "boolean" },
		},
	});
	generateActivity({
		output: values.output,
		aggregateOnly: values["aggregate-only"],
	}).catch(() => {
		console.error(
			"日次データの収集に失敗しました。設定と集計元へのアクセス権を確認してください。",
		);
		process.exitCode = 1;
	});
}
