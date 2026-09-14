export const ACTIVITY_METRICS = [
	"changedLines",
	"commits",
	"mergedPRs",
	"ciRuns",
] as const;

export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];
export type ActivityPeriod = "30d" | "12m" | "all";

export interface ActivityValues {
	changedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
}

export interface ActivitySnapshot extends ActivityValues {
	/** Git のコミッター日時（ISO 8601） */
	committedAt: string;
}

export interface ActivityPoint extends ActivityValues {
	date: string;
}

export interface MonthlyActivityPoint extends ActivityValues {
	month: string;
}

export interface ActivityData {
	rangeEnd: string;
	daily: ActivityPoint[];
	monthly: MonthlyActivityPoint[];
}

export interface ActivityChartPoint extends ActivityValues {
	key: string;
	granularity: "day" | "month";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO_VALUES: ActivityValues = {
	changedLines: 0,
	commits: 0,
	mergedPRs: 0,
	ciRuns: 0,
};

function cloneZeroValues(): ActivityValues {
	return { ...ZERO_VALUES };
}

function isFiniteDate(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function jstDateParts(value: string): {
	year: number;
	month: number;
	day: number;
} {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error(`Invalid activity date: ${value}`);
	}

	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(timestamp));
	const values = new Map(
		parts
			.filter(
				(part) =>
					part.type === "year" || part.type === "month" || part.type === "day",
			)
			.map((part) => [part.type, Number.parseInt(part.value, 10)]),
	);

	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	if (year === undefined || month === undefined || day === undefined) {
		throw new Error(`Unable to convert activity date to JST: ${value}`);
	}
	return { year, month, day };
}

function dateFromParts(year: number, month: number, day: number): Date {
	return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date): string {
	return [
		date.getUTCFullYear().toString().padStart(4, "0"),
		(date.getUTCMonth() + 1).toString().padStart(2, "0"),
		date.getUTCDate().toString().padStart(2, "0"),
	].join("-");
}

function parseCalendarDate(value: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`Invalid activity calendar date: ${value}`);
	}
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(timestamp)) {
		throw new Error(`Invalid activity calendar date: ${value}`);
	}
	return new Date(timestamp);
}

function addDays(value: string, days: number): string {
	const date = parseCalendarDate(value);
	date.setUTCDate(date.getUTCDate() + days);
	return formatDate(date);
}

function daysBetween(start: string, end: string): number {
	return Math.round(
		(parseCalendarDate(end).getTime() - parseCalendarDate(start).getTime()) /
			DAY_MS,
	);
}

function compareDates(left: string, right: string): number {
	return parseCalendarDate(left).getTime() - parseCalendarDate(right).getTime();
}

function normalizeValue(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeValues(values: ActivityValues): ActivityValues {
	return {
		changedLines: normalizeValue(values.changedLines),
		commits: normalizeValue(values.commits),
		mergedPRs: normalizeValue(values.mergedPRs),
		ciRuns: normalizeValue(values.ciRuns),
	};
}

function addValues(target: ActivityValues, values: ActivityValues): void {
	for (const metric of ACTIVITY_METRICS) {
		target[metric] += values[metric];
	}
}

function subtractValues(
	current: ActivityValues,
	previous: ActivityValues,
): ActivityValues {
	const delta = cloneZeroValues();
	for (const metric of ACTIVITY_METRICS) {
		delta[metric] = Math.max(0, current[metric] - previous[metric]);
	}
	return delta;
}

/** コミッター日時を JST に変換し、表示・集計対象の日付を前日にずらす。 */
export function toResultDate(committedAt: string): string {
	const { year, month, day } = jstDateParts(committedAt);
	const jstDate = formatDate(dateFromParts(year, month, day));
	return addDays(jstDate, -1);
}

/** 差分を日数へ均等配分し、余りを新しい日付側へ寄せる。 */
export function distributeActivityDelta(
	startDate: string,
	endDate: string,
	delta: ActivityValues,
): Map<string, ActivityValues> {
	const result = new Map<string, ActivityValues>();
	const normalized = normalizeValues(delta);
	const span = daysBetween(startDate, endDate);
	if (span < 0) {
		const fallback = cloneZeroValues();
		addValues(fallback, normalized);
		result.set(endDate, fallback);
		return result;
	}

	const dayCount = span + 1;
	for (let index = 0; index < dayCount; index++) {
		const date = addDays(startDate, index);
		const values = cloneZeroValues();
		for (const metric of ACTIVITY_METRICS) {
			const quotient = Math.floor(normalized[metric] / dayCount);
			const remainder = normalized[metric] % dayCount;
			const receivesRemainder = index >= dayCount - remainder;
			values[metric] = quotient + (receivesRemainder ? 1 : 0);
		}
		result.set(date, values);
	}
	return result;
}

function addEvent(
	events: Map<string, ActivityValues>,
	date: string,
	values: ActivityValues,
): void {
	const target = events.get(date) ?? cloneZeroValues();
	addValues(target, values);
	events.set(date, target);
}

function buildRepositoryEvents(snapshots: ReadonlyArray<ActivitySnapshot>): {
	baselineDate: string;
	latestDate: string;
	events: Map<string, ActivityValues>;
} | null {
	const validSnapshots = snapshots
		.filter((snapshot) => isFiniteDate(snapshot.committedAt))
		.map((snapshot) => ({
			...snapshot,
			...normalizeValues(snapshot),
		}))
		.sort(
			(left, right) =>
				Date.parse(left.committedAt) - Date.parse(right.committedAt),
		);
	if (validSnapshots.length === 0) return null;

	const baselineDate = toResultDate(validSnapshots[0].committedAt);
	let previousDate = baselineDate;
	let previousValues = normalizeValues(validSnapshots[0]);
	let latestDate = baselineDate;
	const events = new Map<string, ActivityValues>();

	for (const snapshot of validSnapshots.slice(1)) {
		const currentDate = toResultDate(snapshot.committedAt);
		const currentValues = normalizeValues(snapshot);
		const delta = subtractValues(currentValues, previousValues);
		// 同日更新はその日に合算し、それ以外は前回結果日の翌日から配分する。
		const distributionStart =
			currentDate === previousDate ? currentDate : addDays(previousDate, 1);
		const distributed = distributeActivityDelta(
			distributionStart,
			currentDate,
			delta,
		);
		for (const [date, values] of distributed) addEvent(events, date, values);
		previousDate = currentDate;
		previousValues = currentValues;
		if (compareDates(currentDate, latestDate) > 0) latestDate = currentDate;
	}

	return { baselineDate, latestDate, events };
}

function createDailyPoints(
	startDate: string,
	endDate: string,
	events: Map<string, ActivityValues>,
): ActivityPoint[] {
	const points: ActivityPoint[] = [];
	const dayCount = Math.max(0, daysBetween(startDate, endDate)) + 1;
	for (let index = 0; index < dayCount; index++) {
		const date = addDays(startDate, index);
		points.push({ date, ...(events.get(date) ?? cloneZeroValues()) });
	}
	return points;
}

function createMonthlyPoints(
	startDate: string,
	endDate: string,
	daily: ReadonlyArray<ActivityPoint>,
): MonthlyActivityPoint[] {
	const startMonth = startDate.slice(0, 7);
	const endMonth = endDate.slice(0, 7);
	const totals = new Map<string, ActivityValues>();
	for (const point of daily) {
		const values = totals.get(point.date.slice(0, 7)) ?? cloneZeroValues();
		addValues(values, point);
		totals.set(point.date.slice(0, 7), values);
	}

	const points: MonthlyActivityPoint[] = [];
	const monthDate = parseCalendarDate(`${startMonth}-01`);
	const endMonthDate = parseCalendarDate(`${endMonth}-01`);
	while (monthDate.getTime() <= endMonthDate.getTime()) {
		const month = `${monthDate.getUTCFullYear().toString().padStart(4, "0")}-${(monthDate.getUTCMonth() + 1).toString().padStart(2, "0")}`;
		points.push({ month, ...(totals.get(month) ?? cloneZeroValues()) });
		monthDate.setUTCMonth(monthDate.getUTCMonth() + 1);
	}
	return points;
}

/** リポジトリごとのスナップショットを合算した日次・月次データを作る。 */
export function buildActivityData(
	repositories: ReadonlyArray<ReadonlyArray<ActivitySnapshot>>,
): ActivityData {
	const events = new Map<string, ActivityValues>();
	let startDate: string | undefined;
	let rangeEnd: string | undefined;

	for (const snapshots of repositories) {
		const repository = buildRepositoryEvents(snapshots);
		if (!repository) continue;
		if (
			startDate === undefined ||
			compareDates(repository.baselineDate, startDate) < 0
		) {
			startDate = repository.baselineDate;
		}
		if (
			rangeEnd === undefined ||
			compareDates(repository.latestDate, rangeEnd) > 0
		) {
			rangeEnd = repository.latestDate;
		}
		for (const [date, values] of repository.events)
			addEvent(events, date, values);
	}

	if (startDate === undefined || rangeEnd === undefined) {
		return { rangeEnd: "1970-01-01", daily: [], monthly: [] };
	}

	const daily = createDailyPoints(startDate, rangeEnd, events);
	const monthly = createMonthlyPoints(startDate, rangeEnd, daily);
	return { rangeEnd, daily, monthly };
}

function pointValues(
	point: ActivityPoint | MonthlyActivityPoint,
): ActivityValues {
	return {
		changedLines: point.changedLines,
		commits: point.commits,
		mergedPRs: point.mergedPRs,
		ciRuns: point.ciRuns,
	};
}

function monthFromOffset(endMonth: string, offset: number): string {
	const date = parseCalendarDate(`${endMonth}-01`);
	date.setUTCMonth(date.getUTCMonth() + offset);
	return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

/** グラフの期間選択に合わせて、欠測の日・月を 0 で補完した系列を返す。 */
export function selectActivityRange(
	data: ActivityData,
	period: ActivityPeriod,
): ActivityChartPoint[] {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(data.rangeEnd)) return [];
	try {
		parseCalendarDate(data.rangeEnd);
	} catch {
		return [];
	}
	if (period === "all") {
		const endMonth = data.rangeEnd.slice(0, 7);
		const validMonths = data.monthly.filter((point) => {
			if (!/^\d{4}-\d{2}$/.test(point.month) || point.month > endMonth) {
				return false;
			}
			try {
				parseCalendarDate(`${point.month}-01`);
				return true;
			} catch {
				return false;
			}
		});
		if (validMonths.length === 0) return [];
		const startMonth = validMonths.reduce(
			(earliest, point) => (point.month < earliest ? point.month : earliest),
			validMonths[0].month,
		);
		const pointMap = new Map(validMonths.map((point) => [point.month, point]));
		const points: ActivityChartPoint[] = [];
		const monthDate = parseCalendarDate(`${startMonth}-01`);
		const endMonthDate = parseCalendarDate(`${endMonth}-01`);
		while (monthDate.getTime() <= endMonthDate.getTime()) {
			const key = `${monthDate.getUTCFullYear().toString().padStart(4, "0")}-${(monthDate.getUTCMonth() + 1).toString().padStart(2, "0")}`;
			points.push({
				key,
				granularity: "month",
				...pointValues(
					pointMap.get(key) ?? { ...cloneZeroValues(), month: key },
				),
			});
			monthDate.setUTCMonth(monthDate.getUTCMonth() + 1);
		}
		return points;
	}

	if (period === "30d") {
		const pointMap = new Map(data.daily.map((point) => [point.date, point]));
		return Array.from({ length: 30 }, (_, index) => {
			const key = addDays(data.rangeEnd, index - 29);
			return {
				key,
				granularity: "day" as const,
				...pointValues(
					pointMap.get(key) ?? { ...cloneZeroValues(), date: key },
				),
			};
		});
	}

	const pointMap = new Map(data.monthly.map((point) => [point.month, point]));
	return Array.from({ length: 12 }, (_, index) => {
		const key = monthFromOffset(data.rangeEnd.slice(0, 7), index - 11);
		return {
			key,
			granularity: "month" as const,
			...pointValues(pointMap.get(key) ?? { ...cloneZeroValues(), month: key }),
		};
	});
}
