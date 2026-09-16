import { describe, expect, it } from "vitest";
import {
	ACTIVITY_METRICS,
	activityBlockCount,
	activityPointLabel,
	activityScore,
	activitySummary,
	addDays,
	buildActivityData,
	isCalendarDate,
	type RepositoryActivity,
	selectActivityRange,
	toActivityDate,
	zeroActivity,
} from "./activity";

function repository(): RepositoryActivity {
	return {
		version: 2,
		collectedAt: "2026-05-16T00:00:00Z",
		startDate: "2026-05-13",
		gitCacheKey: "",
		metrics: {
			changedLines: {
				days: { "2026-05-13": 100, "2026-05-15": 900, "2026-05-16": 9999 },
				completeFrom: "2026-05-13",
				completeThrough: "2026-05-15",
			},
			commits: {
				days: { "2026-05-13": 1, "2026-05-15": 3 },
				completeFrom: "2026-05-13",
				completeThrough: "2026-05-15",
			},
			mergedPRs: {
				days: {},
				completeFrom: "2026-05-13",
				completeThrough: "2026-05-15",
			},
			ciRuns: {
				days: { "2026-05-13": 5 },
				completeFrom: "2026-05-15",
				completeThrough: "2026-05-15",
			},
		},
	};
}
describe("実日時の日次集計", () => {
	it("JSTの午前0時を境に分類し、前日へ付け替えない", () => {
		expect(toActivityDate("2026-01-01T14:59:59Z")).toBe("2026-01-01");
		expect(toActivityDate("2026-01-01T15:00:00Z")).toBe("2026-01-02");
		expect(() => toActivityDate("invalid")).toThrow();
	});
	it("実在する日付だけを受け付ける", () => {
		expect(isCalendarDate("2024-02-29")).toBe(true);
		expect(isCalendarDate("2025-02-29")).toBe(false);
		expect(isCalendarDate("2026-13-01")).toBe(false);
		expect(isCalendarDate("invalid")).toBe(false);
		expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
		expect(() => addDays("invalid", 1)).toThrow();
	});
	it("初回の活動を元の日付に含め、活動のない日を均等配分で埋めない", () => {
		const result = buildActivityData([repository()], "2026-05-16T00:00:00Z");
		expect(result.rangeStart).toBe("2026-05-13");
		expect(result.rangeEnd).toBe("2026-05-15");
		expect(result.daily.map((point) => point.changedLines)).toEqual([
			100, 0, 900,
		]);
		expect(result.daily[0].incomplete).toEqual(["ciRuns"]);
		expect(result.daily[1].ciRuns).toBe(0);
		expect(result.daily[1].incomplete).toContain("ciRuns");
		expect(result.daily[2].incomplete).toBeUndefined();
	});
	it("複数リポジトリを合算し、作成前の期間は未取得としない", () => {
		const later = repository();
		later.startDate = "2026-05-15";
		for (const metric of ACTIVITY_METRICS)
			later.metrics[metric] = {
				days: {},
				completeFrom: null,
				completeThrough: null,
			};
		later.metrics.commits.days["2026-05-15"] = 2;
		const result = buildActivityData(
			[repository(), later],
			"2026-05-16T00:00:00Z",
		);
		expect(result.daily[0].incomplete).toEqual(["ciRuns"]);
		expect(result.daily[2].incomplete).toEqual([...ACTIVITY_METRICS]);
		expect(result.daily[2].commits).toBe(5);
	});
	it("更新が途切れたリポジトリの未取得日を完全な0として扱わない", () => {
		const result = buildActivityData([repository()], "2026-05-18T00:00:00Z");
		expect(result.daily.at(-1)?.incomplete).toEqual([...ACTIVITY_METRICS]);
	});
	it("対象が空でも当日を含めない", () => {
		const result = buildActivityData([], "2026-01-01T15:00:00Z");
		expect(result.rangeEnd).toBe("2026-01-01");
		expect(result.repositoryCount).toBe(0);
		expect(result.daily).toHaveLength(1);
	});
});

describe("活動量のスケール", () => {
	const day = (commits: number, mergedPRs: number, changedLines: number) => ({
		...zeroActivity(),
		commits,
		mergedPRs,
		changedLines,
	});
	it("3指標を固定基準で正規化して平均し、0を持ち上げない", () => {
		expect(activityBlockCount(day(0, 0, 0))).toBe(0);
		expect(activityBlockCount(day(1, 0, 0))).toBe(1);
		expect(activityBlockCount(day(25, 0, 0))).toBe(2);
		expect(activityBlockCount(day(100, 0, 0))).toBe(4);
		expect(activityBlockCount(day(10, 2, 1000))).toBe(3);
		expect(activityBlockCount(day(100, 50, 10000))).toBe(10);
		expect(activityScore(day(100, 50, 10000))).toBe(1);
	});
	it("基準を超えた日は10段で頭打ちにし、不正な値は0として扱う", () => {
		expect(activityBlockCount(day(1000, 500, 100000))).toBe(10);
		expect(activityScore(day(1000, 500, 100000))).toBe(1);
		expect(activityBlockCount(day(-1, Number.NaN, 0))).toBe(0);
	});
	it("CI Runs はスコアに含めず、ツールチップにだけ実値を出す", () => {
		const point = {
			key: "2026-01-01",
			granularity: "day" as const,
			...zeroActivity(),
			ciRuns: 30,
		};
		expect(activityBlockCount(point)).toBe(0);
		expect(activityPointLabel(point)).toBe(
			"2026-01-01 · 0 commits · 0 merged PRs · 0 changed lines · 30 CI runs",
		);
		expect(
			activityPointLabel({ ...point, ciRuns: 0, incomplete: ["ciRuns"] }),
		).toBe(
			"2026-01-01 · 0 commits · 0 merged PRs · 0 changed lines · ≥ 0 CI runs",
		);
		expect(
			activityPointLabel({ ...point, commits: 3, incomplete: ["commits"] }),
		).toBe(
			"2026-01-01 · ≥ 3 commits · 0 merged PRs · 0 changed lines · 30 CI runs",
		);
	});
});

describe("期間の選択", () => {
	const data = buildActivityData([repository()], "2026-05-16T00:00:00Z");
	it("直近90日を終端日込みで返す", () => {
		const points = selectActivityRange(data, "90d");
		expect(points).toHaveLength(90);
		expect(points[0].key).toBe("2026-02-15");
		expect(points.at(-1)?.changedLines).toBe(900);
		expect(points.every((point) => point.granularity === "day")).toBe(true);
	});
	it("12ヶ月を日次で返し、うるう日も含める", () => {
		expect(selectActivityRange(data, "12m")).toHaveLength(349);
		const leap = selectActivityRange(
			{ ...data, rangeEnd: "2024-02-29" },
			"12m",
		);
		expect(leap).toHaveLength(366);
		expect(leap[0].key).toBe("2023-03-01");
	});
	it("全期間を最古日から返し、不完全な取得情報を保持する", () => {
		const points = selectActivityRange(data, "all");
		expect(points).toHaveLength(3);
		expect(points[0].incomplete).toEqual(["ciRuns"]);
		expect(points.at(-1)?.incomplete).toBeUndefined();
	});
	it("不正な範囲を空にする", () => {
		expect(
			selectActivityRange({ ...data, rangeEnd: "invalid" }, "90d"),
		).toEqual([]);
		expect(
			selectActivityRange({ ...data, rangeStart: "invalid" }, "all"),
		).toEqual([]);
		expect(
			selectActivityRange({ ...data, rangeStart: "2030-01-01" }, "all"),
		).toEqual([]);
	});
});

describe("期間内の実績表示", () => {
	it("活動日数と総数を実測値から算出する", () => {
		const points = selectActivityRange(
			buildActivityData([repository()], "2026-05-16T00:00:00Z"),
			"all",
		);
		expect(activitySummary(points)).toBe(
			"4 commits · 0 merged PRs · 1,000 changed lines · 2 active days / 3 days",
		);
	});
	it("未取得の期間を含む合計は下限値として示す", () => {
		const points = selectActivityRange(
			buildActivityData([repository()], "2026-05-18T00:00:00Z"),
			"all",
		);
		expect(activitySummary(points)).toBe(
			"≥ 4 commits · ≥ 0 merged PRs · ≥ 10,999 changed lines · ≥ 3 active days / 5 days",
		);
	});
});
