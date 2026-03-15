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
import { parse as parseYaml } from "yaml";

const { values: args } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
	},
});
const isDryRun = args["dry-run"] ?? false;

interface RepoConfig {
	repo: string; // "owner/name" or "self"
	alias?: string;
}
interface PortalConfig {
	repositories: RepoConfig[];
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

interface SingleRepoMetrics {
	linesOfCode: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	extLines: Map<string, number>;
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

function loadConfig(): PortalConfig {
	const defaultConfig: PortalConfig = { repositories: [{ repo: "self" }] };

	let rawYaml: string | undefined;

	if (process.env.PORTAL_CONFIG) {
		rawYaml = process.env.PORTAL_CONFIG;
		console.error("Config: PORTAL_CONFIG 環境変数から読み込み");
	} else {
		const localPath = resolve(process.cwd(), ".portal.yaml");
		if (existsSync(localPath)) {
			rawYaml = readFileSync(localPath, "utf-8");
			console.error("Config: .portal.yaml から読み込み");
		}
	}

	if (!rawYaml) {
		console.error("Config: 設定なし → self のみ（フォールバック）");
		return defaultConfig;
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(rawYaml);
	} catch (err) {
		console.error("Error: YAML パース失敗:", err);
		process.exit(1);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("repositories" in parsed) ||
		!Array.isArray((parsed as { repositories: unknown }).repositories)
	) {
		console.error('Error: 設定に "repositories" 配列が必要です');
		process.exit(1);
	}

	const repos = (parsed as { repositories: unknown[] }).repositories;
	for (const item of repos) {
		if (typeof item !== "object" || item === null || !("repo" in item)) {
			console.error(
				'Error: 各 repositories エントリに "repo" が必要です:',
				item,
			);
			process.exit(1);
		}
		const repoVal = (item as { repo: unknown }).repo;
		if (typeof repoVal !== "string") {
			console.error('Error: "repo" は文字列である必要があります:', repoVal);
			process.exit(1);
		}
		if (
			repoVal !== "self" &&
			!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoVal)
		) {
			console.error(
				`Error: "repo" は "self" または "owner/name" の形式にしてください: ${repoVal}`,
			);
			process.exit(1);
		}
		if ("alias" in item) {
			const aliasVal = (item as { alias: unknown }).alias;
			if (typeof aliasVal !== "string") {
				console.error('Error: "alias" は文字列である必要があります:', aliasVal);
				process.exit(1);
			}
		}
	}

	return parsed as PortalConfig;
}

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

function collectSingleRepo(config: RepoConfig): SingleRepoMetrics {
	const displayName = config.alias ?? config.repo;
	const isSelf = config.repo === "self";
	let repoDir = process.cwd();
	let tmpDir: string | undefined;

	if (!isSelf) {
		tmpDir = mkdtempSync(join(tmpdir(), "collect-metrics-"));
		console.error(`[${displayName}] Cloning into ${tmpDir}...`);
		try {
			execFileSync("gh", ["repo", "clone", config.repo, tmpDir], {
				stdio: config.alias ? "pipe" : "inherit",
			});
		} catch {
			rmSync(tmpDir, { recursive: true, force: true });
			console.error(
				`Error: リポジトリ "${displayName}" が見つかりません。\n` +
					`  - owner/name の形式で指定してください\n` +
					`  - リポジトリへのアクセス権があるか確認してください`,
			);
			process.exit(1);
		}
		repoDir = tmpDir;
	} else {
		console.error(`[${displayName}] カレントディレクトリを使用`);
	}

	const repoFlags = isSelf ? [] : ["-R", config.repo];

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
		} catch {
			console.error(`[${displayName}] Warning: Failed to get merged PRs count`);
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
				{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
			);
			ciRuns = (JSON.parse(runOutput) as Array<{ databaseId: number }>).length;
		} catch (err) {
			const stderr =
				err instanceof Error && "stderr" in err
					? String((err as NodeJS.ErrnoException & { stderr: unknown }).stderr)
					: "";
			if (!stderr.includes("HTTP 403")) {
				console.error(`[${displayName}] Warning: Failed to get CI runs count`);
			}
		}

		console.error(
			`[${displayName}] LOC=${totalLines}, commits=${commits}, PRs=${mergedPRs}, CI=${ciRuns}`,
		);

		return { linesOfCode: totalLines, commits, mergedPRs, ciRuns, extLines };
	} finally {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			console.error(`[${displayName}] Cleaned up ${tmpDir}`);
		}
	}
}

function aggregateMetrics(results: SingleRepoMetrics[]): {
	linesOfCode: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	extLines: Map<string, number>;
} {
	const merged = {
		linesOfCode: 0,
		commits: 0,
		mergedPRs: 0,
		ciRuns: 0,
		extLines: new Map<string, number>(),
	};

	for (const r of results) {
		merged.linesOfCode += r.linesOfCode;
		merged.commits += r.commits;
		merged.mergedPRs += r.mergedPRs;
		merged.ciRuns += r.ciRuns;
		for (const [ext, lines] of r.extLines) {
			merged.extLines.set(ext, (merged.extLines.get(ext) ?? 0) + lines);
		}
	}

	return merged;
}

function main(): void {
	const config = loadConfig();

	const results: SingleRepoMetrics[] = [];
	for (const repoConfig of config.repositories) {
		const metrics = collectSingleRepo(repoConfig);
		results.push(metrics);
	}

	const aggregated = aggregateMetrics(results);
	const languages = calcLanguages(aggregated.extLines);

	const result: MetricsResult = {
		linesOfCode: aggregated.linesOfCode,
		commits: aggregated.commits,
		mergedPRs: aggregated.mergedPRs,
		ciRuns: aggregated.ciRuns,
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
