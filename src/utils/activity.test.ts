import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectActivitySnapshots } from "../../scripts/generate-activity";
import generatedActivity from "../data/activity.json";
import {
	type ActivityData,
	type ActivitySnapshot,
	buildActivityData,
	distributeActivityDelta,
	selectActivityRange,
	toResultDate,
} from "./activity";

function snapshot(
	committedAt: string,
	values: Partial<Omit<ActivitySnapshot, "committedAt" | "changedLines">> & {
		addedLines?: number;
		deletedLines?: number;
		changedLines?: number;
	},
): ActivitySnapshot {
	return {
		committedAt,
		changedLines:
			values.changedLines ??
			(values.addedLines ?? 0) + (values.deletedLines ?? 0),
		commits: values.commits ?? 0,
		mergedPRs: values.mergedPRs ?? 0,
		ciRuns: values.ciRuns ?? 0,
	};
}

function valuesAt(data: ActivityData, date: string) {
	return data.daily.find((point) => point.date === date);
}

describe("toResultDate", () => {
	it("コミッター日時を JST に変換して前日を返す", () => {
		expect(toResultDate("2026-09-14T19:43:59Z")).toBe("2026-09-14");
		expect(toResultDate("2026-01-01T14:59:59Z")).toBe("2025-12-31");
		expect(toResultDate("2026-01-01T15:00:00Z")).toBe("2026-01-01");
	});
});

describe("distributeActivityDelta", () => {
	it("割り切れる差分を各日に配分する", () => {
		const result = distributeActivityDelta("2026-01-01", "2026-01-03", {
			changedLines: 6,
			commits: 3,
			mergedPRs: 0,
			ciRuns: 9,
		});
		expect([...result.values()].map((value) => value.changedLines)).toEqual([
			2, 2, 2,
		]);
		expect([...result.values()].map((value) => value.commits)).toEqual([
			1, 1, 1,
		]);
	});

	it("余りを新しい日付側へ配分し、日数未満の差分も失わない", () => {
		const result = distributeActivityDelta("2026-01-01", "2026-01-03", {
			changedLines: 5,
			commits: 1,
			mergedPRs: 2,
			ciRuns: 0,
		});
		expect([...result.values()].map((value) => value.changedLines)).toEqual([
			1, 2, 2,
		]);
		expect([...result.values()].map((value) => value.commits)).toEqual([
			0, 0, 1,
		]);
		expect([...result.values()].map((value) => value.mergedPRs)).toEqual([
			0, 1, 1,
		]);
	});

	it("逆順の日付では終端日にまとめる", () => {
		const result = distributeActivityDelta("2026-01-03", "2026-01-01", {
			changedLines: 2,
			commits: 0,
			mergedPRs: 0,
			ciRuns: 0,
		});
		expect(result.get("2026-01-01")?.changedLines).toBe(2);
	});
});

describe("buildActivityData", () => {
	it("基準スナップショットを除外し、欠測区間を均等配分する", () => {
		const data = buildActivityData([
			[
				snapshot("2026-01-01T00:00:00Z", {
					changedLines: 100,
					commits: 10,
					mergedPRs: 4,
					ciRuns: 20,
				}),
				snapshot("2026-01-04T00:00:00Z", {
					changedLines: 105,
					commits: 12,
					mergedPRs: 5,
					ciRuns: 20,
				}),
			],
		]);

		expect(data.rangeEnd).toBe("2026-01-03");
		expect(data.daily[0]?.date).toBe("2025-12-31");
		expect(data.daily.slice(-3).map((point) => point.changedLines)).toEqual([
			1, 2, 2,
		]);
		expect(data.daily.slice(-3).map((point) => point.commits)).toEqual([
			0, 1, 1,
		]);
		expect(data.daily.reduce((sum, point) => sum + point.changedLines, 0)).toBe(
			5,
		);
		expect(data.monthly).toEqual([
			{
				month: "2025-12",
				changedLines: 0,
				commits: 0,
				mergedPRs: 0,
				ciRuns: 0,
			},
			{
				month: "2026-01",
				changedLines: 5,
				commits: 2,
				mergedPRs: 1,
				ciRuns: 0,
			},
		]);
	});

	it("負の差分を 0 にし、同日更新はその日に合算する", () => {
		const data = buildActivityData([
			[
				snapshot("2026-02-01T00:00:00Z", {
					changedLines: 10,
					commits: 3,
					mergedPRs: 1,
					ciRuns: 4,
				}),
				snapshot("2026-02-02T00:00:00Z", {
					changedLines: 5,
					commits: 2,
					mergedPRs: 3,
					ciRuns: 5,
				}),
				snapshot("2026-02-02T12:00:00Z", {
					changedLines: 8,
					commits: 4,
					mergedPRs: 4,
					ciRuns: 7,
				}),
			],
		]);
		const point = valuesAt(data, "2026-02-01");
		expect(point).toMatchObject({
			changedLines: 3,
			commits: 2,
			mergedPRs: 3,
			ciRuns: 3,
		});
	});

	it("複数リポジトリを合算し、活動のない日と月を 0 で補完する", () => {
		const data = buildActivityData([
			[
				snapshot("2026-03-01T00:00:00Z", { changedLines: 0 }),
				snapshot("2026-03-03T00:00:00Z", { changedLines: 4 }),
			],
			[
				snapshot("2026-02-01T00:00:00Z", { commits: 1 }),
				snapshot("2026-02-02T00:00:00Z", { commits: 3 }),
			],
		]);
		expect(data.rangeEnd).toBe("2026-03-02");
		expect(valuesAt(data, "2026-03-01")).toMatchObject({ changedLines: 2 });
		expect(valuesAt(data, "2026-03-02")).toMatchObject({ changedLines: 2 });
		expect(data.monthly.map((point) => point.month)).toEqual([
			"2026-01",
			"2026-02",
			"2026-03",
		]);
		expect(
			data.monthly.find((point) => point.month === "2026-02")?.commits,
		).toBe(2);
	});

	it("空の入力では空の系列を返す", () => {
		expect(buildActivityData([])).toEqual({
			rangeEnd: "1970-01-01",
			daily: [],
			monthly: [],
		});
	});
});

describe("selectActivityRange", () => {
	const data: ActivityData = {
		rangeEnd: "2026-05-15",
		daily: [
			{
				date: "2026-05-15",
				changedLines: 10,
				commits: 2,
				mergedPRs: 1,
				ciRuns: 3,
			},
		],
		monthly: [
			{
				month: "2026-04",
				changedLines: 4,
				commits: 1,
				mergedPRs: 2,
				ciRuns: 3,
			},
			{
				month: "2026-05",
				changedLines: 6,
				commits: 2,
				mergedPRs: 3,
				ciRuns: 4,
			},
		],
	};

	it("直近30日を終端日込みで 0 補完する", () => {
		const range = selectActivityRange(data, "30d");
		expect(range).toHaveLength(30);
		expect(range[0]).toMatchObject({ key: "2026-04-16", changedLines: 0 });
		expect(range.at(-1)).toMatchObject({ key: "2026-05-15", changedLines: 10 });
	});

	it("直近12ヶ月を終端月込みで 0 補完する", () => {
		const range = selectActivityRange(data, "12m");
		expect(range).toHaveLength(12);
		expect(range[0]).toMatchObject({ key: "2025-06", commits: 0 });
		expect(range.at(-2)).toMatchObject({ key: "2026-04", commits: 1 });
		expect(range.at(-1)).toMatchObject({ key: "2026-05", commits: 2 });
	});

	it("全期間は最古月から終端月まで 0 補完する", () => {
		const range = selectActivityRange(
			{
				...data,
				rangeEnd: "2026-06-15",
				monthly: [data.monthly[0], { ...data.monthly[1], month: "2026-06" }],
			},
			"all",
		);
		expect(range.map((point) => point.key)).toEqual([
			"2026-04",
			"2026-05",
			"2026-06",
		]);
		expect(range[1]).toMatchObject({
			changedLines: 0,
			commits: 0,
			mergedPRs: 0,
			ciRuns: 0,
		});
		expect(range.every((point) => point.granularity === "month")).toBe(true);
	});

	it("不正な終端日は空系列にする", () => {
		expect(
			selectActivityRange({ ...data, rangeEnd: "unknown" }, "30d"),
		).toEqual([]);
	});
});

describe("生成済み activity.json", () => {
	it("日次・月次のスキーマと合計が一致する", () => {
		expect(generatedActivity.rangeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(generatedActivity.daily.at(-1)?.date).toBe(
			generatedActivity.rangeEnd,
		);
		expect(
			generatedActivity.daily.every(
				(point) =>
					/^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
					Object.values(point).every((value) =>
						typeof value === "number"
							? Number.isInteger(value) && value >= 0
							: true,
					),
			),
		).toBe(true);
		expect(
			generatedActivity.monthly.every((point) =>
				/^\d{4}-\d{2}$/.test(point.month),
			),
		).toBe(true);

		for (const month of generatedActivity.monthly) {
			const dailyTotal = generatedActivity.daily
				.filter((point) => point.date.startsWith(month.month))
				.reduce(
					(total, point) => ({
						changedLines: total.changedLines + point.changedLines,
						commits: total.commits + point.commits,
						mergedPRs: total.mergedPRs + point.mergedPRs,
						ciRuns: total.ciRuns + point.ciRuns,
					}),
					{
						changedLines: 0,
						commits: 0,
						mergedPRs: 0,
						ciRuns: 0,
					},
				);
			expect(month).toMatchObject(dailyTotal);
		}
	});
});

describe("collectActivitySnapshots", () => {
	it("現行 JSON だけを対象にし、削除済みファイルの履歴を除外する", () => {
		const repository = mkdtempSync(join(tmpdir(), "activity-history-"));
		const dataDirectory = join(repository, "src/data/repositories");
		mkdirSync(dataDirectory, { recursive: true });

		const currentPath = join(dataDirectory, "current.json");
		const deletedPath = join(dataDirectory, "deleted.json");
		const writeSnapshot = (path: string, commits: number) => {
			writeFileSync(
				path,
				JSON.stringify({
					addedLines: commits,
					deletedLines: 1,
					commits,
					mergedPRs: 0,
					ciRuns: 0,
				}),
			);
		};
		const runGit = (args: string[], date: string) => {
			const environment: NodeJS.ProcessEnv = {
				...process.env,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			};
			for (const variable of [
				"GIT_DIR",
				"GIT_WORK_TREE",
				"GIT_INDEX_FILE",
				"GIT_COMMON_DIR",
				"GIT_PREFIX",
			]) {
				delete environment[variable];
			}
			execFileSync("git", args, {
				cwd: repository,
				stdio: "ignore",
				env: environment,
			});
		};

		try {
			runGit(["init", "-q"], "2026-01-01T00:00:00Z");
			runGit(["config", "core.hooksPath", "/dev/null"], "2026-01-01T00:00:00Z");
			runGit(["config", "user.name", "Activity Test"], "2026-01-01T00:00:00Z");
			runGit(
				["config", "user.email", "activity-test@example.com"],
				"2026-01-01T00:00:00Z",
			);
			writeSnapshot(currentPath, 1);
			writeSnapshot(deletedPath, 1);
			runGit(["add", "."], "2026-01-01T00:00:00Z");
			runGit(["commit", "-qm", "初回スナップショット"], "2026-01-01T00:00:00Z");

			writeSnapshot(currentPath, 3);
			runGit(["add", "."], "2026-01-03T00:00:00Z");
			runGit(["commit", "-qm", "現行ファイルを更新"], "2026-01-03T00:00:00Z");

			rmSync(deletedPath);
			runGit(["add", "-u"], "2026-01-04T00:00:00Z");
			runGit(["commit", "-qm", "ファイルを削除"], "2026-01-04T00:00:00Z");

			const snapshots = collectActivitySnapshots(dataDirectory, repository);
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]).toHaveLength(2);
			expect(snapshots[0]?.map((item) => item.commits)).toEqual([1, 3]);
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});
});
