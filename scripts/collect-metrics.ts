import { execFileSync, execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		repo: { type: "string" },
	},
});
const isDryRun = args["dry-run"] ?? false;
const repoArg = args.repo; // e.g. "HappyOnigiri/Refix"
if (repoArg && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoArg)) {
	console.error(`Error: --repo must be in "owner/name" format`);
	process.exit(1);
}

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
	{
		id: "JavaScript",
		label: "JavaScript",
		exts: [".js", ".jsx", ".mjs", ".cjs"],
		color: "#f1e05a",
	},
	{ id: "Python", label: "Python", exts: [".py"], color: "#3572A5" },
	{ id: "Java", label: "Java", exts: [".java"], color: "#b07219" },
	{ id: "Kotlin", label: "Kotlin", exts: [".kt", ".kts"], color: "#A97BFF" },
	{ id: "Swift", label: "Swift", exts: [".swift"], color: "#F05138" },
	{ id: "Go", label: "Go", exts: [".go"], color: "#00ADD8" },
	{ id: "Rust", label: "Rust", exts: [".rs"], color: "#dea584" },
	{ id: "C", label: "C", exts: [".c", ".h"], color: "#555555" },
	{
		id: "C++",
		label: "C++",
		exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
		color: "#f34b7d",
	},
	{ id: "C#", label: "C#", exts: [".cs"], color: "#178600" },
	{ id: "Ruby", label: "Ruby", exts: [".rb"], color: "#701516" },
	{ id: "PHP", label: "PHP", exts: [".php"], color: "#4F5D95" },
	{ id: "Dart", label: "Dart", exts: [".dart"], color: "#00B4AB" },
	{ id: "Scala", label: "Scala", exts: [".scala"], color: "#c22d40" },
	{
		id: "Shell",
		label: "Shell",
		exts: [".sh", ".bash", ".zsh"],
		color: "#89e051",
	},
	{ id: "Lua", label: "Lua", exts: [".lua"], color: "#000080" },
	{ id: "R", label: "R", exts: [".r", ".R"], color: "#198CE7" },
	{ id: "Haskell", label: "Haskell", exts: [".hs"], color: "#5e5086" },
	{ id: "Elixir", label: "Elixir", exts: [".ex", ".exs"], color: "#6e4a7e" },
	{
		id: "Clojure",
		label: "Clojure",
		exts: [".clj", ".cljs", ".cljc"],
		color: "#db5855",
	},
	{ id: "Zig", label: "Zig", exts: [".zig"], color: "#ec915c" },
	{ id: "Nim", label: "Nim", exts: [".nim"], color: "#ffc200" },
	{ id: "OCaml", label: "OCaml", exts: [".ml", ".mli"], color: "#3be133" },
	{ id: "F#", label: "F#", exts: [".fs", ".fsi", ".fsx"], color: "#b845fc" },
	{ id: "Julia", label: "Julia", exts: [".jl"], color: "#a270ba" },
	{ id: "Perl", label: "Perl", exts: [".pl", ".pm"], color: "#0298c3" },
	{ id: "Erlang", label: "Erlang", exts: [".erl"], color: "#B83998" },
	{ id: "Astro", label: "Astro", exts: [".astro"], color: "#ff5a03" },
	{ id: "Vue", label: "Vue", exts: [".vue"], color: "#41b883" },
	{ id: "Svelte", label: "Svelte", exts: [".svelte"], color: "#ff3e00" },
];

function getExcludedPatterns(repoDir: string): string[] {
	const gitattributesPath = resolve(repoDir, ".gitattributes");
	if (!existsSync(gitattributesPath)) return [];
	const content = readFileSync(gitattributesPath, "utf-8");
	const patterns: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const attrs = trimmed.split(/\s+/).slice(1);
		if (
			attrs.some(
				(a) =>
					a === "linguist-generated" ||
					a === "linguist-generated=true" ||
					a === "linguist-vendored" ||
					a === "linguist-vendored=true",
			)
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
		.replace(/\/DOUBLESTAR\//g, "/(?:[^/]+/)*")
		.replace(/DOUBLESTAR/g, ".*");
	return new RegExp(`(^|/)${regexStr}($|/)`);
}

function isExcluded(filePath: string, patterns: string[]): boolean {
	return patterns.some((p) => patternToRegex(p).test(filePath));
}

function countFileLines(repoDir: string, filePath: string): number {
	try {
		const content = readFileSync(join(repoDir, filePath), "utf-8");
		if (content.length === 0) return 0;
		return content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
	} catch {
		return 0;
	}
}

function calcLanguages(extLines: Map<string, number>): LanguageResult[] {
	const rawValues = LANGUAGE_GROUPS.map((group) => {
		let lines = 0;
		for (const ext of group.exts) {
			lines += extLines.get(ext) ?? 0;
		}
		return { ...group, lines };
	}).filter((g) => g.lines > 0);

	const matchedTotal = rawValues.reduce((sum, g) => sum + g.lines, 0);
	if (matchedTotal === 0) return [];

	const rawPcts = rawValues.map((g) => (g.lines / matchedTotal) * 100);
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
			rawPct: rawPcts[i],
		}))
		.filter((g) => g.value > 0)
		.sort((a, b) => b.rawPct - a.rawPct)
		.slice(0, 10)
		.map(({ id, label, value, color }) => ({ id, label, value, color }));
}

function main(): void {
	let repoDir = process.cwd();
	let tmpDir: string | undefined;

	if (repoArg) {
		tmpDir = mkdtempSync(join(tmpdir(), "collect-metrics-"));
		console.error(`Cloning ${repoArg} into ${tmpDir}...`);
		try {
			execFileSync("gh", ["repo", "clone", repoArg, tmpDir], {
				stdio: "inherit",
			});
		} catch {
			rmSync(tmpDir, { recursive: true, force: true });
			console.error(
				`Error: リポジトリ "${repoArg}" が見つかりません。\n` +
					`  - owner/name の形式で指定してください\n` +
					`  - リポジトリへのアクセス権があるか確認してください`,
			);
			process.exit(1);
		}
		repoDir = tmpDir;
	}

	const repoFlags = repoArg ? ["-R", repoArg] : [];

	try {
		const excludedPatterns = getExcludedPatterns(repoDir);

		const allFiles = execSync("git ls-files", {
			encoding: "utf-8",
			cwd: repoDir,
		})
			.trim()
			.split("\n")
			.filter((f) => f.length > 0)
			.filter((f) => !isExcluded(f, excludedPatterns));

		const extLines = new Map<string, number>();
		let totalLines = 0;

		for (const file of allFiles) {
			const lines = countFileLines(repoDir, file);
			const ext = extname(file).toLowerCase();
			extLines.set(ext, (extLines.get(ext) ?? 0) + lines);
			totalLines += lines;
		}

		const commits = Number(
			execSync("git rev-list --count HEAD", {
				encoding: "utf-8",
				cwd: repoDir,
			}).trim(),
		);

		let mergedPRs = 0;
		try {
			const prOutput = execFileSync(
				"gh",
				[
					"pr",
					"list",
					...repoFlags,
					"--state",
					"merged",
					"--json",
					"number",
					"--limit",
					"9999",
				],
				{ encoding: "utf-8" },
			);
			mergedPRs = (JSON.parse(prOutput) as Array<{ number: number }>).length;
		} catch (err) {
			console.error("Warning: Failed to get merged PRs count:", err);
		}

		let ciRuns = 0;
		try {
			const runOutput = execFileSync(
				"gh",
				[
					"run",
					"list",
					...repoFlags,
					"--json",
					"databaseId",
					"--limit",
					"9999",
				],
				{ encoding: "utf-8" },
			);
			ciRuns = (JSON.parse(runOutput) as Array<{ databaseId: number }>).length;
		} catch (err) {
			console.error("Warning: Failed to get CI runs count:", err);
		}

		const languages = calcLanguages(extLines);

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
	} finally {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			console.error(`Cleaned up ${tmpDir}`);
		}
	}
}

main();
