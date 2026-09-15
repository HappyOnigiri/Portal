import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Api,
	collectPulls,
	collectRuns,
	fetchRuns,
	parseGitActivity,
	readRepositoryActivity,
} from "../../scripts/generate-activity";

describe("集計元のGit履歴", () => {
	it("過去の初回コミットを含め、純粋なリネームを行数に重複計上しない", () => {
		const directory = mkdtempSync(join(tmpdir(), "portal-source-test-"));
		const environment = {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "検証用",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "検証用",
			GIT_COMMITTER_EMAIL: "test@example.com",
		};
		for (const key of [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_PREFIX",
		])
			delete environment[key as keyof typeof environment];
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: directory,
				env: environment,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		try {
			git("init");
			const commit = (date: string) => {
				git("add", ".");
				execFileSync("git", ["commit", "-m", "検証用"], {
					cwd: directory,
					env: {
						...environment,
						GIT_AUTHOR_DATE: date,
						GIT_COMMITTER_DATE: date,
					},
					stdio: "ignore",
				});
			};
			writeFileSync(
				join(directory, "before.ts"),
				"const a = 1;\nconst b = 2;\n",
			);
			writeFileSync(join(directory, "generated.ts"), "const generated = 1;\n");
			commit("2020-01-01T23:00:00+09:00");
			const root = git("rev-parse", "HEAD").trim();
			renameSync(join(directory, "before.ts"), join(directory, "after.ts"));
			commit("2020-01-03T23:00:00+09:00");
			const log = git(
				"log",
				"--no-merges",
				"--find-renames",
				"--numstat",
				"-z",
				"--format=%x1e%H%x09%aI",
			);
			const result = parseGitActivity(log, ["generated.ts"]);
			expect(result.commits).toEqual({ "2020-01-03": 1, "2020-01-01": 1 });
			expect(result.changedLines["2020-01-01"]).toBe(2);
			expect(result.changedLines["2020-01-03"] ?? 0).toBe(0);
			expect(
				parseGitActivity(log, [], [root]).commits["2020-01-01"],
			).toBeUndefined();
			const dailyPath = join(directory, "daily.json");
			const cumulativePath = join(directory, "cumulative.json");
			execFileSync(
				"python3",
				[
					resolve("scripts/count-loc.py"),
					directory,
					"--offline",
					"--output",
					cumulativePath,
					"--activity-output",
					dailyPath,
					"--exclude-commit",
					root,
				],
				{ env: environment, stdio: "pipe" },
			);
			const local = JSON.parse(readFileSync(dailyPath, "utf8"));
			expect(local.metrics.commits.days).toEqual(
				parseGitActivity(log, [], [root]).commits,
			);
			expect(local.metrics.changedLines.days).toEqual(
				parseGitActivity(log, [], [root]).changedLines,
			);
			expect(local.metrics.ciRuns.completeFrom).toBeNull();
			expect(local.metrics.mergedPRs.completeThrough).toBeNull();
			expect(local.gitCacheKey).toBe("");
			expect(readRepositoryActivity(dailyPath)?.version).toBe(2);
			const imported = join(directory, "src/data/activity-repositories/Works");
			const online = join(directory, "src/data/activity-repositories/owner");
			mkdirSync(imported, { recursive: true });
			mkdirSync(online, { recursive: true });
			writeFileSync(
				join(directory, ".portal.yaml"),
				"repositories:\n  - repo: owner/repo\n",
			);
			local.collectedAt = "2020-01-05T00:00:00Z";
			writeFileSync(join(imported, "local.json"), JSON.stringify(local));
			const remote = structuredClone(local);
			remote.collectedAt = "2020-01-04T00:00:00Z";
			remote.metrics.commits.days = { "2020-01-03": 4 };
			writeFileSync(join(online, "repo.json"), JSON.stringify(remote));
			const aggregated = join(directory, "aggregate.json");
			execFileSync(
				"node",
				[
					resolve("scripts/generate-activity.ts"),
					"--aggregate-only",
					"--output",
					aggregated,
				],
				{
					cwd: directory,
					env: {
						...environment,
						PORTAL_CONFIG: "repositories:\n  - repo: owner/repo\n",
					},
					stdio: "pipe",
				},
			);
			const combined = JSON.parse(readFileSync(aggregated, "utf8"));
			expect(combined.repositoryCount).toBe(2);
			expect(combined.collectedAt).toBe(local.collectedAt);
			expect(combined.rangeEnd).toBe("2020-01-04");
			expect(readFileSync(join(online, "repo.json"), "utf8")).toBe(
				JSON.stringify(remote),
			);
			expect(
				combined.daily.find(
					(point: { date: string }) => point.date === "2020-01-03",
				).commits,
			).toBe(5);
			writeFileSync(
				dailyPath,
				JSON.stringify({
					...local,
					metrics: {
						...local.metrics,
						commits: { ...local.metrics.commits, days: { invalid: -1 } },
					},
				}),
			);
			expect(readRepositoryActivity(dailyPath)).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("バイナリ・非ソースと重複コミットを除外する", () => {
		const entry =
			"\x1eabc\t2026-01-01T00:00:00Z\0\n-\t-\timage.png\0\n5\t2\tREADME.md\0\n2\t1\tfile.ts\0";
		expect(parseGitActivity(entry + entry, []).changedLines).toEqual({
			"2026-01-01": 3,
		});
	});
});

describe("PRの日次履歴", () => {
	it("マージ日時と本人で集計し、クローズのみのPRを除外する", async () => {
		const request: Api = async <T>() =>
			[
				{
					number: 1,
					merged_at: "2026-01-01T15:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					login: "Me",
				},
				{
					number: 2,
					merged_at: null,
					updated_at: "2026-01-03T00:00:00Z",
					login: "me",
				},
				{
					number: 3,
					merged_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					login: "other",
				},
			] as T;
		const result = await collectPulls(
			request,
			"owner/repo",
			["me"],
			"2020-01-01",
			"2026-01-02",
		);
		expect(result.days).toEqual({ "2026-01-02": 1 });
		expect(result.completeFrom).toBe("2020-01-01");
	});
	it("取得済みの過去日を保持し、増分のPRだけを追加する", async () => {
		const previous = {
			days: { "2026-01-01": 4 },
			completeFrom: "2026-01-01",
			completeThrough: "2026-01-01",
		};
		const request: Api = async <T>() =>
			[
				{
					number: 1,
					merged_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					login: "me",
				},
				{
					number: 2,
					merged_at: "2026-01-02T00:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					login: "me",
				},
			] as T;
		expect(
			(
				await collectPulls(
					request,
					"o/r",
					[],
					"2026-01-01",
					"2026-01-02",
					previous,
				)
			).days,
		).toEqual({ "2026-01-01": 4, "2026-01-02": 1 });
	});
});

describe("CIの日次履歴", () => {
	it("1000件を超える検索を境界が重ならない区間へ分割する", async () => {
		const ranges: string[] = [];
		const request: Api = async <T>(endpoint: string) => {
			const url = new URL(endpoint, "https://example.test/");
			const range = url.searchParams.get("created") ?? "";
			ranges.push(range);
			if (ranges.length === 1) return { total_count: 1001, runs: [] } as T;
			return {
				total_count: 1,
				runs: [
					{ id: ranges.length, created_at: range.split("..")[0], login: "me" },
				],
			} as T;
		};
		expect(
			await fetchRuns(
				request,
				"o/r",
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:03.000Z",
			),
		).toHaveLength(2);
		expect(ranges.slice(1)).toEqual([
			"2026-01-01T00:00:00.000Z..2026-01-01T00:00:01.000Z",
			"2026-01-01T00:00:02.000Z..2026-01-01T00:00:03.000Z",
		]);
	});
	it("ページを最後まで取得し、件数の不一致を成功扱いしない", async () => {
		const request: Api = async <T>(endpoint: string) =>
			({
				total_count: 101,
				runs: Array.from(
					{ length: endpoint.includes("page=2&") ? 1 : 100 },
					(_, i) => ({
						id: endpoint.includes("page=2&") ? 100 : i,
						created_at: "2026-01-01T00:00:00Z",
						login: null,
					}),
				),
			}) as T;
		expect(
			await fetchRuns(
				request,
				"o/r",
				"2026-01-01T00:00:00Z",
				"2026-01-02T00:00:00Z",
			),
		).toHaveLength(101);
		const broken: Api = async <T>() => ({ total_count: 2, runs: [] }) as T;
		await expect(
			fetchRuns(broken, "o/r", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
		).rejects.toThrow();
	});
	it("初回取得前の履歴を完全な件数とせず、JSTの日付で保存する", async () => {
		const request: Api = async <T>() =>
			({
				total_count: 2,
				runs: [
					{ id: 1, created_at: "2026-01-01T15:00:00Z", login: "me" },
					{ id: 2, created_at: "2026-01-01T15:00:00Z", login: "other" },
				],
			}) as T;
		const result = await collectRuns(
			request,
			"o/r",
			["me"],
			"2026-01-01",
			"2026-01-02",
			"2026-01-03",
		);
		expect(result.days).toEqual({ "2026-01-02": 1 });
		expect(result.completeFrom).toBe("2026-01-03");
	});
	it("取得済みrunがAPIから消えても過去のアーカイブを維持する", async () => {
		const request: Api = async <T>() => ({ total_count: 0, runs: [] }) as T;
		const previous = {
			days: { "2026-01-01": 3 },
			completeFrom: "2026-01-01",
			completeThrough: "2026-01-01",
		};
		const result = await collectRuns(
			request,
			"o/r",
			[],
			"2026-01-01",
			"2026-01-02",
			"2026-01-03",
			previous,
		);
		expect(result.days).toEqual({ "2026-01-01": 3 });
		expect(result.completeFrom).toBe("2026-01-01");
		expect(
			await collectRuns(
				request,
				"o/r",
				[],
				"2026-01-01",
				"2026-01-01",
				"2026-01-02",
				previous,
			),
		).toBe(previous);
	});
});
