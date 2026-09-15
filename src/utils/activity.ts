export const ACTIVITY_METRICS = [
	"changedLines",
	"commits",
	"mergedPRs",
	"ciRuns",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];
export type ActivityPeriod = "90d" | "12m" | "all";

export const ACTIVITY_BLOCK_COLORS = [
	"#5794f2",
	"#469fea",
	"#35add4",
	"#2bbbab",
	"#4bc982",
	"#80c968",
	"#bac456",
	"#e3ac56",
	"#ef815e",
	"#f05e6b",
] as const;

export interface ActivityValues {
	changedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
}
export interface ActivityPoint extends ActivityValues {
	date: string;
	/** 取得できた件数のみ。0でも活動なしとは限らない。 */
	incomplete?: ActivityMetric[];
}
export interface ActivityChartPoint extends ActivityValues {
	key: string;
	granularity: "day";
	incomplete?: ActivityMetric[];
}
export interface MetricSeries {
	days: Record<string, number>;
	completeFrom: string | null;
	completeThrough: string | null;
}
export interface RepositoryActivity {
	version: 2;
	collectedAt: string;
	startDate: string;
	gitCacheKey: string;
	metrics: Record<ActivityMetric, MetricSeries>;
}
export interface ActivityData {
	version: 2;
	rangeStart: string;
	rangeEnd: string;
	collectedAt: string;
	repositoryCount: number;
	daily: ActivityPoint[];
	/** 全期間共通の平方根スケール。期間切替で同じ日の高さを変えない。 */
	scaleMax: Record<ActivityMetric, number>;
}

export const zeroActivity = (): ActivityValues => ({
	changedLines: 0,
	commits: 0,
	mergedPRs: 0,
	ciRuns: 0,
});

export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(value + "T00:00:00Z");
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

export function addDays(date: string, offset: number): string {
	if (!isCalendarDate(date)) throw new Error("日付が不正です");
	const parsed = new Date(date + "T00:00:00Z");
	parsed.setUTCDate(parsed.getUTCDate() + offset);
	return parsed.toISOString().slice(0, 10);
}

/** イベントの実日時をJSTの日付に変換する。前日への付け替えは行わない。 */
export function toActivityDate(timestamp: string): string {
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) throw new Error("イベント日時が不正です");
	return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function activityBlockCount(value: number, scaleMax: number): number {
	if (!Number.isFinite(value) || value <= 0 || scaleMax <= 0) return 0;
	// [Intended] 小さな活動も見える平方根スケール。上限超過は実値をツールチップで示す。
	return Math.min(10, Math.ceil(10 * Math.sqrt(value / scaleMax)));
}

function niceCeiling(value: number): number {
	const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
	const fraction = value / magnitude;
	const step = [1, 2, 5, 10].find((candidate) => candidate >= fraction) ?? 10;
	return step * magnitude;
}

/** 観測できた活動日の95パーセンタイルから、全期間共通の上限を決める。 */
export function activityScaleMax(
	points: ActivityPoint[],
	metric: ActivityMetric,
): number {
	const values = points
		.map((point) => point[metric])
		.filter((value) => value > 0)
		.sort((a, b) => a - b);
	if (values.length === 0) return 10;
	return Math.max(10, niceCeiling(values[Math.ceil(values.length * 0.95) - 1]));
}

export function buildActivityData(
	repositories: RepositoryActivity[],
	collectedAt: string,
): ActivityData {
	// [Intended] 当日は途中経過なので、直近の完了したJST日までを表示する。
	const rangeEnd = addDays(toActivityDate(collectedAt), -1);
	const starts = repositories
		.map((repo) => repo.startDate)
		.filter((date) => isCalendarDate(date) && date <= rangeEnd)
		.sort();
	const rangeStart = starts[0] ?? rangeEnd;
	const daily: ActivityPoint[] = [];
	for (let date = rangeStart; date <= rangeEnd; date = addDays(date, 1)) {
		const point: ActivityPoint = { date, ...zeroActivity() };
		const incomplete = new Set<ActivityMetric>();
		for (const repository of repositories) {
			if (date < repository.startDate) continue;
			for (const metric of ACTIVITY_METRICS) {
				const series = repository.metrics[metric];
				point[metric] += series.days[date] ?? 0;
				if (
					!series.completeFrom ||
					!series.completeThrough ||
					date < series.completeFrom ||
					date > series.completeThrough
				)
					incomplete.add(metric);
			}
		}
		if (incomplete.size) point.incomplete = [...incomplete];
		daily.push(point);
	}
	const scaleMax = { changedLines: 10, commits: 10, mergedPRs: 10, ciRuns: 10 };
	for (const metric of ACTIVITY_METRICS)
		scaleMax[metric] = activityScaleMax(daily, metric);
	return {
		version: 2,
		rangeStart,
		rangeEnd,
		collectedAt,
		repositoryCount: repositories.length,
		daily,
		scaleMax,
	};
}

export function selectActivityRange(
	data: ActivityData,
	period: ActivityPeriod,
): ActivityChartPoint[] {
	if (!isCalendarDate(data.rangeEnd)) return [];
	let start = data.rangeStart;
	if (period === "90d") start = addDays(data.rangeEnd, -89);
	if (period === "12m") {
		const date = new Date(data.rangeEnd.slice(0, 7) + "-01T00:00:00Z");
		date.setUTCMonth(date.getUTCMonth() - 11);
		start = date.toISOString().slice(0, 10);
	}
	if (!isCalendarDate(start) || start > data.rangeEnd) return [];
	const points = new Map(data.daily.map((point) => [point.date, point]));
	const result: ActivityChartPoint[] = [];
	for (let date = start; date <= data.rangeEnd; date = addDays(date, 1)) {
		const point = points.get(date);
		result.push({
			key: date,
			granularity: "day",
			...zeroActivity(),
			...(point
				? {
						changedLines: point.changedLines,
						commits: point.commits,
						mergedPRs: point.mergedPRs,
						ciRuns: point.ciRuns,
						...(point.incomplete ? { incomplete: point.incomplete } : {}),
					}
				: {}),
		});
	}
	return result;
}

export function activitySummary(
	points: ActivityChartPoint[],
	metric: ActivityMetric,
): string {
	const units: Record<ActivityMetric, string> = {
		changedLines: "changed lines",
		commits: "commits",
		mergedPRs: "merged PRs",
		ciRuns: "CI runs",
	};
	const partial = points.some((point) => point.incomplete?.includes(metric));
	const total = points.reduce((sum, point) => sum + point[metric], 0);
	const active = points.filter((point) => point[metric] > 0).length;
	const number = new Intl.NumberFormat("en-US");
	return `${partial ? "≥ " : ""}${number.format(total)} ${units[metric]} · ${partial && active < points.length ? "≥ " : ""}${active} active days / ${points.length} days`;
}
