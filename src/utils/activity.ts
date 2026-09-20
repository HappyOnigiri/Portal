export const ACTIVITY_METRICS = [
	"changedLines",
	"commits",
	"mergedPRs",
	"ciRuns",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];
export type ActivityPeriod = "90d" | "12m" | "all";

// [Intended] CI Runs はスコアに含めない。定期実行の run が毎日の床になって無活動日が消えること、
// コミット・PR の結果であり二重計上になること、初回取得前が常に未取得扱いになることが理由。
export const ACTIVITY_SCORE_METRICS = [
	"commits",
	"mergedPRs",
	"changedLines",
] as const;
export type ActivityScoreMetric = (typeof ACTIVITY_SCORE_METRICS)[number];

// [Policy] 表示スケールは固定値。活動量の増減で過去の日の高さが変わらないよう、データから再計算しない。
// 値は 2026-09 時点の全期間の活動日 95 パーセンタイルを切り上げたもの。
export const ACTIVITY_SCALE_REFERENCE: Readonly<
	Record<ActivityScoreMetric, number>
> = {
	commits: 100,
	mergedPRs: 50,
	changedLines: 10000,
};
/** 平方根スケール。小さな活動も見えるように圧縮する。 */
export const ACTIVITY_SCORE_EXPONENT = 0.5;

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

export const ACTIVITY_METRIC_UNITS: Record<ActivityMetric, string> = {
	commits: "commits",
	mergedPRs: "merged PRs",
	changedLines: "changed lines",
	ciRuns: "CI runs",
};

const numberFormat = new Intl.NumberFormat("en-US");
export const formatActivityNumber = (value: number): string =>
	numberFormat.format(value);

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
}

export const zeroActivity = (): ActivityValues => ({
	changedLines: 0,
	commits: 0,
	mergedPRs: 0,
	ciRuns: 0,
});

export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

export function addDays(date: string, offset: number): string {
	if (!isCalendarDate(date)) throw new Error("日付が不正です");
	const parsed = new Date(`${date}T00:00:00Z`);
	parsed.setUTCDate(parsed.getUTCDate() + offset);
	return parsed.toISOString().slice(0, 10);
}

/** イベントの実日時をJSTの日付に変換する。前日への付け替えは行わない。 */
export function toActivityDate(timestamp: string): string {
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) throw new Error("イベント日時が不正です");
	return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 3指標を固定基準で 0〜1 に正規化し、平方根をとって平均したスコア。基準超過は 1 に丸める。 */
export function activityScore(values: ActivityValues): number {
	let total = 0;
	for (const metric of ACTIVITY_SCORE_METRICS) {
		const value = values[metric];
		if (!Number.isFinite(value) || value <= 0) continue;
		total +=
			Math.min(1, value / ACTIVITY_SCALE_REFERENCE[metric]) **
			ACTIVITY_SCORE_EXPONENT;
	}
	return total / ACTIVITY_SCORE_METRICS.length;
}

/** 0 は 0 段、活動があれば最低 1 段、最大 10 段。 */
export function activityBlockCount(values: ActivityValues): number {
	const score = activityScore(values);
	if (score <= 0) return 0;
	return Math.min(10, Math.ceil(10 * score));
}

/** スコアに使う指標のいずれかが未取得の日。 */
export function isActivityPartial(point: {
	incomplete?: ActivityMetric[];
}): boolean {
	return ACTIVITY_SCORE_METRICS.some((metric) =>
		point.incomplete?.includes(metric),
	);
}

// [Intended] 未取得の指標は 0 でも「≥ 0」と示す。オンライン収集分では確定した 0 で、
// ローカル集計分だけが不明という混在があるため、「取得不能」とは言い切れない。
function formatMetricValue(
	value: number,
	metric: ActivityMetric,
	incomplete: boolean,
): string {
	return `${incomplete ? "≥ " : ""}${numberFormat.format(value)} ${ACTIVITY_METRIC_UNITS[metric]}`;
}

/** ツールチップと読み上げ用。日付と4指標の実値を並べる。 */
export function activityPointLabel(point: ActivityChartPoint): string {
	const parts = [...ACTIVITY_SCORE_METRICS, "ciRuns" as const].map((metric) =>
		formatMetricValue(
			point[metric],
			metric,
			point.incomplete?.includes(metric) ?? false,
		),
	);
	return [point.key, ...parts].join(" · ");
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
	return {
		version: 2,
		rangeStart,
		rangeEnd,
		collectedAt,
		repositoryCount: repositories.length,
		daily,
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
		const date = new Date(`${data.rangeEnd.slice(0, 7)}-01T00:00:00Z`);
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

/** 期間内の合計と活動日数。未取得を含む合計は下限値として「≥」を付ける。 */
export function activitySummary(points: ActivityChartPoint[]): string {
	const totals = ACTIVITY_SCORE_METRICS.map((metric) => {
		const partial = points.some((point) => point.incomplete?.includes(metric));
		const total = points.reduce((sum, point) => sum + point[metric], 0);
		return `${partial ? "≥ " : ""}${numberFormat.format(total)} ${ACTIVITY_METRIC_UNITS[metric]}`;
	});
	const partial = points.some(isActivityPartial);
	const active = points.filter((point) => activityBlockCount(point) > 0).length;
	return `${totals.join(" · ")} · ${partial && active < points.length ? "≥ " : ""}${active} active days / ${points.length} days`;
}
