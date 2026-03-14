import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const isDryRun = process.argv.includes("--dry-run");

interface LanguageGroup {
	id: string;
	label: string;
	exts: string[];
	color: string;
}

interface LanguageResult {
	id: string;
	label: string;
	value: number;
	color: string;
}

interface MetricsResult {
	linesOfCode: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	lastUpdated: string;
	languages: LanguageResult[];
	aiUsage: LanguageResult[];
	aiTokens: number;
}

const LANGUAGE_GROUPS: LanguageGroup[] = [
	{
		id: "TypeScript",
		label: "TypeScript",
		exts: [".ts", ".tsx"],
		color: "#3178c6",
	},
	{ id: "Astro", label: "Astro", exts: [".astro"], color: "#ff5a03" },
	{ id: "CSS", label: "CSS", exts: [".css"], color: "#563d7c" },
	{ id: "Python", label: "Python", exts: [".py"], color: "#3572A5" },
	{ id: "YAML", label: "YAML", exts: [".yaml", ".yml"], color: "#cb171e" },
	{ id: "Other", label: "Other", exts: [], color: "#ededed" },
];

function getExcludedPatterns(): string[] {
	const gitattributesPath = resolve(process.cwd(), ".gitattributes");
	if (!existsSync(gitattributesPath)) return [];
	const content = readFileSync(gitattributesPath, "utf-8");
	const patterns: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (
			trimmed.includes("linguist-generated") ||
			trimmed.includes("linguist-vendored")
		) {
			const pattern = trimmed.split(/\s+/)[0];
			if (pattern) patterns.push(pattern);
		}
	}
	return patterns;
}

function patternToRegex(pattern: string): RegExp {
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "DOUBLESTAR")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/DOUBLESTAR/g, ".*");
	return new RegExp(`(^|/)${regexStr}($|/)`);
}

function isExcluded(filePath: string, patterns: string[]): boolean {
	return patterns.some((p) => patternToRegex(p).test(filePath));
}

function countFileLines(filePath: string): number {
	try {
		const content = readFileSync(filePath, "utf-8");
		return content.split("\n").length;
	} catch {
		return 0;
	}
}

function calcLanguages(
	extLines: Map<string, number>,
	totalLines: number,
): LanguageResult[] {
	if (totalLines === 0) return [];

	const knownExts = new Set(LANGUAGE_GROUPS.flatMap((g) => g.exts));

	const rawValues = LANGUAGE_GROUPS.map((group) => {
		let lines = 0;
		if (group.exts.length === 0) {
			for (const [ext, count] of extLines) {
				if (!knownExts.has(ext)) lines += count;
			}
		} else {
			for (const ext of group.exts) {
				lines += extLines.get(ext) ?? 0;
			}
		}
		return { ...group, lines };
	}).filter((g) => g.lines > 0);

	const rawPcts = rawValues.map((g) => (g.lines / totalLines) * 100);
	const floors = rawPcts.map(Math.floor);
	const remainder = 100 - floors.reduce((a, b) => a + b, 0);

	rawPcts
		.map((r, i) => ({ index: i, frac: r - Math.floor(r) }))
		.sort((a, b) => b.frac - a.frac)
		.slice(0, remainder)
		.forEach(({ index }) => {
			floors[index]++;
		});

	return rawValues
		.map((g, i) => ({
			id: g.id,
			label: g.label,
			value: floors[i],
			color: g.color,
		}))
		.filter((g) => g.value > 0);
}

function main(): void {
	const excludedPatterns = getExcludedPatterns();

	const allFiles = execSync("git ls-files", { encoding: "utf-8" })
		.trim()
		.split("\n")
		.filter((f) => f.length > 0)
		.filter((f) => !isExcluded(f, excludedPatterns));

	const extLines = new Map<string, number>();
	let totalLines = 0;

	for (const file of allFiles) {
		const lines = countFileLines(file);
		const ext = extname(file).toLowerCase();
		extLines.set(ext, (extLines.get(ext) ?? 0) + lines);
		totalLines += lines;
	}

	const commits = Number(
		execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim(),
	);

	let mergedPRs = 0;
	try {
		const prOutput = execSync(
			"gh pr list --state merged --json number --limit 9999",
			{ encoding: "utf-8" },
		);
		mergedPRs = (JSON.parse(prOutput) as Array<{ number: number }>).length;
	} catch (err) {
		console.error("Warning: Failed to get merged PRs count:", err);
	}

	let ciRuns = 0;
	try {
		const runOutput = execSync("gh run list --json databaseId --limit 9999", {
			encoding: "utf-8",
		});
		ciRuns = (JSON.parse(runOutput) as Array<{ databaseId: number }>).length;
	} catch (err) {
		console.error("Warning: Failed to get CI runs count:", err);
	}

	const languages = calcLanguages(extLines, totalLines);

	const result: MetricsResult = {
		linesOfCode: totalLines,
		commits,
		mergedPRs,
		ciRuns,
		lastUpdated: new Date().toISOString(),
		languages,
		aiUsage: [],
		aiTokens: 0,
	};

	if (isDryRun) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const outputPath = resolve(process.cwd(), "src/data/author-status.json");
		writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
		console.log(`Written to ${outputPath}`);
	}
}

main();
