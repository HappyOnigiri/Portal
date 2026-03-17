import { execFile, execFileSync } from "node:child_process";
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
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { parse as parseYaml } from "yaml";

const { values: args } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		local: { type: "string" },
		output: { type: "string" },
	},
});
const isDryRun = args["dry-run"] ?? false;

interface RepoConfig {
	repo: string; // "owner/name" or "self"
	alias?: string;
}
interface AuthorConfig {
	emails?: string[];
	names?: string[];
	github?: string;
}
interface PortalConfig {
	repositories: RepoConfig[];
	author?: AuthorConfig;
	salt?: string;
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
	addedLines: number;
	deletedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	lastUpdated: string;
	languages: LanguageResult[];
	aiUsage: LanguageResult[];
	aiTokens: number;
}

interface SingleRepoMetrics {
	addedLines: number;
	deletedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	extLines: Map<string, number>;
}

interface PerRepoFileData {
	cacheKey: string;
	addedLines: number;
	deletedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	extLines: Record<string, number>;
	collectedAt: string;
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

/** ソースコードとしてカウントする拡張子（画像・lock・バイナリを除外） */
const SOURCE_EXTS = new Set(LANGUAGE_GROUPS.flatMap((g) => g.exts));

/** git log / git blame の stdout 上限（大規模リポジトリでのバッファ超過を防ぐ） */
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

const REPO_DATA_DIR = resolve(process.cwd(), "src/data/repositories");

function loadConfig(): PortalConfig {
	const defaultConfig: PortalConfig = { repositories: [{ repo: "self" }] };

	let rawYaml: string | undefined;

	if (process.env.PORTAL_CONFIG !== undefined) {
		if (process.env.PORTAL_CONFIG.trim() === "") {
			console.error(
				"Error: PORTAL_CONFIG が空文字です。有効な YAML を設定してください",
			);
			process.exit(1);
		}
		rawYaml = process.env.PORTAL_CONFIG;
		console.error("Config: PORTAL_CONFIG 環境変数から読み込み");
	} else {
		const localPath = resolve(process.cwd(), ".portal.yaml");
		if (existsSync(localPath)) {
			const content = readFileSync(localPath, "utf-8");
			if (content.trim() === "") {
				console.error(
					"Error: .portal.yaml が空ファイルです。有効な YAML を記述してください",
				);
				process.exit(1);
			}
			rawYaml = content;
			console.error("Config: .portal.yaml から読み込み");
		}
	}

	if (rawYaml === undefined) {
		console.error("Config: 設定なし → self のみ（フォールバック）");
		return defaultConfig;
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(rawYaml);
	} catch {
		console.error("Error: YAML パース失敗");
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
	if (repos.length === 0) {
		console.error("Error: repositories には最低1件のエントリが必要です");
		process.exit(1);
	}
	for (let index = 0; index < repos.length; index++) {
		const item = repos[index];
		if (typeof item !== "object" || item === null || !("repo" in item)) {
			console.error(`Error: repositories[${index}] に "repo" が必要です`);
			process.exit(1);
		}
		const repoVal = (item as { repo: unknown }).repo;
		if (typeof repoVal !== "string") {
			console.error(
				`Error: repositories[${index}] の "repo" は文字列である必要があります`,
			);
			process.exit(1);
		}
		if (
			repoVal !== "self" &&
			!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoVal)
		) {
			console.error(
				`Error: repositories[${index}] の "repo" は "self" または "owner/name" の形式にしてください`,
			);
			process.exit(1);
		}
		if ("alias" in item) {
			const aliasVal = (item as { alias: unknown }).alias;
			if (typeof aliasVal !== "string") {
				console.error(
					`Error: repositories[${index}] の "alias" は文字列である必要があります`,
				);
				process.exit(1);
			}
		}
	}

	const parsedConfig = parsed as PortalConfig;

	if ("author" in parsedConfig && parsedConfig.author !== undefined) {
		const author = parsedConfig.author;
		if (typeof author !== "object" || author === null) {
			console.error('Error: "author" はオブジェクトである必要があります');
			process.exit(1);
		}
		if ("emails" in author && author.emails !== undefined) {
			if (
				!Array.isArray(author.emails) ||
				author.emails.some((e) => typeof e !== "string")
			) {
				console.error(
					'Error: "author.emails" は文字列の配列である必要があります',
				);
				process.exit(1);
			}
		}
		if ("names" in author && author.names !== undefined) {
			if (
				!Array.isArray(author.names) ||
				author.names.some((n) => typeof n !== "string")
			) {
				console.error(
					'Error: "author.names" は文字列の配列である必要があります',
				);
				process.exit(1);
			}
		}
		if ("github" in author && author.github !== undefined) {
			if (typeof author.github !== "string") {
				console.error('Error: "author.github" は文字列である必要があります');
				process.exit(1);
			}
		}
	}

	if ("salt" in parsedConfig && parsedConfig.salt !== undefined) {
		if (typeof parsedConfig.salt !== "string") {
			console.error('Error: "salt" は文字列である必要があります');
			process.exit(1);
		}
	}

	return parsedConfig;
}

function repoToFilePath(config: RepoConfig): string {
	const name = config.alias ?? config.repo;
	const segments = name.split("/");
	const sanitized = segments.map((s) => {
		const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
		if (cleaned === "" || cleaned === "." || cleaned === "..") {
			throw new Error(`Invalid repository path segment: ${s}`);
		}
		return cleaned;
	});
	const last = sanitized[sanitized.length - 1];
	const dirs = sanitized.slice(0, -1);
	const output = resolve(REPO_DATA_DIR, ...dirs, `${last}.json`);
	const rel = relative(REPO_DATA_DIR, output);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Resolved path escapes REPO_DATA_DIR: ${output}`);
	}
	return output;
}

async function getMainCommitHash(config: RepoConfig): Promise<string> {
	try {
		if (config.repo === "self") {
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
				encoding: "utf-8",
				cwd: process.cwd(),
			});
			return stdout.trim();
		} else {
			const { stdout: branch } = await execFileAsync(
				"gh",
				["api", `repos/${config.repo}`, "--jq", ".default_branch"],
				{ encoding: "utf-8" },
			);
			const { stdout } = await execFileAsync(
				"gh",
				[
					"api",
					`repos/${config.repo}/commits/${branch.trim()}`,
					"--jq",
					".sha",
				],
				{ encoding: "utf-8" },
			);
			return stdout.trim();
		}
	} catch (err) {
		console.warn(
			`[${config.alias ?? config.repo}] Warning: main commit hash の取得に失敗しました。cacheKey を空として扱います: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return "";
	}
}

function hmacHash(value: string, salt: string): string {
	return createHmac("sha256", salt).update(value).digest("hex");
}

function readAllPerRepoFiles(): SingleRepoMetrics[] {
	if (!existsSync(REPO_DATA_DIR)) return [];

	const results: SingleRepoMetrics[] = [];

	function walk(dir: string): void {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				try {
					const raw = JSON.parse(readFileSync(fullPath, "utf-8")) as Record<
						string,
						unknown
					>;
					if (
						typeof raw.addedLines !== "number" ||
						typeof raw.deletedLines !== "number" ||
						typeof raw.commits !== "number" ||
						typeof raw.mergedPRs !== "number" ||
						typeof raw.ciRuns !== "number"
					) {
						console.error(
							`Warning: ${fullPath} は必須フィールドが不足しています。スキップします`,
						);
						continue;
					}
					const extLines = new Map<string, number>();
					if (raw.extLines !== null && typeof raw.extLines === "object") {
						for (const [k, v] of Object.entries(
							raw.extLines as Record<string, unknown>,
						)) {
							if (typeof v === "number") extLines.set(k, v);
						}
					}
					results.push({
						addedLines: raw.addedLines,
						deletedLines: raw.deletedLines,
						commits: raw.commits,
						mergedPRs: raw.mergedPRs,
						ciRuns: raw.ciRuns,
						extLines,
					});
				} catch {
					console.error(
						`Warning: ${fullPath} のパースに失敗しました。スキップします`,
					);
				}
			}
		}
	}

	walk(REPO_DATA_DIR);
	return results;
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

async function countNumstatLines(
	repoDir: string,
	excludedPatterns: string[],
	author?: AuthorConfig,
): Promise<{
	addedLines: number;
	deletedLines: number;
	extLines: Map<string, number>;
}> {
	const authorFlags = [
		...(author?.emails ?? []).flatMap((e) => ["--author", e]),
		...(author?.names ?? []).flatMap((n) => ["--author", n]),
	];

	try {
		const { stdout } = await execFileAsync(
			"git",
			[
				"log",
				"--numstat",
				"--format=",
				"--no-renames",
				"--fixed-strings",
				...authorFlags,
			],
			{ encoding: "utf-8", cwd: repoDir, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
		);

		let addedLines = 0;
		let deletedLines = 0;
		const extLines = new Map<string, number>();

		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split("\t");
			if (parts.length < 3) continue;
			const [addedStr, deletedStr, filePath] = parts;
			// バイナリファイルはスキップ
			if (addedStr === "-" || deletedStr === "-") continue;
			if (isExcluded(filePath, excludedPatterns)) continue;
			const ext = extname(filePath).toLowerCase();
			if (!SOURCE_EXTS.has(ext)) continue;
			const added = parseInt(addedStr, 10);
			const deleted = parseInt(deletedStr, 10);
			if (Number.isNaN(added) || Number.isNaN(deleted)) continue;
			addedLines += added;
			deletedLines += deleted;
			extLines.set(ext, (extLines.get(ext) ?? 0) + added);
		}

		return { addedLines, deletedLines, extLines };
	} catch (err) {
		console.error(
			`Warning: git log --numstat failed in ${repoDir}: ${err instanceof Error ? err.message : err}`,
		);
		return { addedLines: 0, deletedLines: 0, extLines: new Map() };
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

function detectGitHubRepoId(repoDir: string): string | null {
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], {
			encoding: "utf-8",
			cwd: repoDir,
		}).trim();
		const match = url.match(
			/github\.com[:/]([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/,
		);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

async function collectSingleRepo(
	config: RepoConfig,
	author?: AuthorConfig,
	overrideDir?: string,
): Promise<SingleRepoMetrics> {
	const displayName = config.alias ?? config.repo;
	const isSelf = config.repo === "self";
	let repoDir = process.cwd();
	let tmpDir: string | undefined;
	const cloneArgs = ["--single-branch"];

	if (overrideDir !== undefined) {
		repoDir = overrideDir;
		console.error(`[${displayName}] ローカルディレクトリを使用: ${repoDir}`);
	} else if (!isSelf) {
		tmpDir = mkdtempSync(join(tmpdir(), "collect-metrics-"));
		console.error(`[${displayName}] Cloning into ${tmpDir}...`);
		try {
			execFileSync(
				"gh",
				["repo", "clone", config.repo, tmpDir, "--", ...cloneArgs],
				{
					stdio: config.alias ? "ignore" : "inherit",
				},
			);
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

	let repoFlags: string[];
	let shouldQueryGitHub: boolean;
	if (overrideDir !== undefined) {
		const detectedId = detectGitHubRepoId(repoDir);
		repoFlags = detectedId ? ["-R", detectedId] : [];
		shouldQueryGitHub = detectedId !== null;
	} else {
		repoFlags = isSelf ? [] : ["-R", config.repo];
		shouldQueryGitHub = true;
	}

	try {
		const excludedPatterns = getExcludedPatterns(repoDir);

		const { addedLines, deletedLines, extLines } = await countNumstatLines(
			repoDir,
			excludedPatterns,
			author,
		);

		const authorFlags = [
			...(author?.emails ?? []).flatMap((e) => ["--author", e]),
			...(author?.names ?? []).flatMap((n) => ["--author", n]),
		];
		const commits = Number(
			execFileSync(
				"git",
				["rev-list", "--count", "--fixed-strings", "HEAD", ...authorFlags],
				{
					encoding: "utf-8",
					cwd: repoDir,
				},
			).trim(),
		);

		const prAuthorFlags = author?.github ? ["--author", author.github] : [];
		let mergedPRs = 0;
		if (shouldQueryGitHub) {
			try {
				const prOutput = execFileSync(
					"gh",
					[
						"pr",
						"list",
						...repoFlags,
						"--state",
						"merged",
						...prAuthorFlags,
						"--json",
						"number",
						"--limit",
						"9999",
					],
					{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
				);
				mergedPRs = (JSON.parse(prOutput) as Array<{ number: number }>).length;
			} catch {
				console.error(
					`[${displayName}] Warning: Failed to get merged PRs count`,
				);
			}
		}

		const runAuthorFlags = author?.github ? ["--user", author.github] : [];
		let ciRuns = 0;
		if (shouldQueryGitHub) {
			try {
				const runOutput = execFileSync(
					"gh",
					[
						"run",
						"list",
						...repoFlags,
						...runAuthorFlags,
						"--json",
						"databaseId",
						"--limit",
						"9999",
					],
					{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
				);
				ciRuns = (
					JSON.parse(runOutput) as Array<{ databaseId: number }>
				).length;
			} catch (err) {
				const stderr =
					err instanceof Error && "stderr" in err
						? String(
								(err as NodeJS.ErrnoException & { stderr: unknown }).stderr,
							)
						: "";
				if (!stderr.includes("HTTP 403")) {
					console.error(
						`[${displayName}] Warning: Failed to get CI runs count`,
					);
				}
			}
		}

		console.error(
			`[${displayName}] added=${addedLines}, deleted=${deletedLines}, commits=${commits}, PRs=${mergedPRs}, CI=${ciRuns}`,
		);

		return { addedLines, deletedLines, commits, mergedPRs, ciRuns, extLines };
	} finally {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			console.error(`[${displayName}] Cleaned up ${tmpDir}`);
		}
	}
}

function aggregateMetrics(results: SingleRepoMetrics[]): {
	addedLines: number;
	deletedLines: number;
	commits: number;
	mergedPRs: number;
	ciRuns: number;
	extLines: Map<string, number>;
} {
	const merged = {
		addedLines: 0,
		deletedLines: 0,
		commits: 0,
		mergedPRs: 0,
		ciRuns: 0,
		extLines: new Map<string, number>(),
	};

	for (const r of results) {
		merged.addedLines += r.addedLines;
		merged.deletedLines += r.deletedLines;
		merged.commits += r.commits;
		merged.mergedPRs += r.mergedPRs;
		merged.ciRuns += r.ciRuns;
		for (const [ext, lines] of r.extLines) {
			merged.extLines.set(ext, (merged.extLines.get(ext) ?? 0) + lines);
		}
	}

	return merged;
}

async function main(): Promise<void> {
	const config = loadConfig();

	// SALT の解決
	let salt: string;
	if (config.salt) {
		salt = config.salt;
	} else if (process.env.PORTAL_SALT) {
		salt = process.env.PORTAL_SALT;
	} else {
		salt = randomBytes(32).toString("hex");
		console.error(
			"Warning: SALT が未設定です。ランダム SALT を使用するためキャッシュが効きません。.portal.yaml に salt を設定してください",
		);
	}

	if (!isDryRun) {
		mkdirSync(REPO_DATA_DIR, { recursive: true });
	}

	const collectedInThisRun: SingleRepoMetrics[] = [];

	for (const repoConfig of config.repositories) {
		const displayName = repoConfig.alias ?? repoConfig.repo;
		const filePath = repoToFilePath(repoConfig);

		// コミットハッシュ取得とキャッシュ判定
		const hash = await getMainCommitHash(repoConfig);
		const authorScope = JSON.stringify({
			emails: [...new Set(config.author?.emails ?? [])].sort(),
			names: [...new Set(config.author?.names ?? [])].sort(),
			github: config.author?.github ?? "",
		});
		const hmac = hash ? hmacHash(`${hash}:${authorScope}`, salt) : "";

		if (hmac && !isDryRun && existsSync(filePath)) {
			try {
				const existing = JSON.parse(
					readFileSync(filePath, "utf-8"),
				) as PerRepoFileData;
				if (existing.cacheKey === hmac) {
					console.error(`[${displayName}] cache hit → スキップ`);
					continue;
				}
			} catch {
				// パース失敗時はキャッシュミス扱い
			}
		}

		const metrics = await collectSingleRepo(repoConfig, config.author);
		collectedInThisRun.push(metrics);

		const extLinesRecord: Record<string, number> = {};
		for (const [k, v] of metrics.extLines) {
			extLinesRecord[k] = v;
		}

		const perRepoData: PerRepoFileData = {
			cacheKey: hmac,
			addedLines: metrics.addedLines,
			deletedLines: metrics.deletedLines,
			commits: metrics.commits,
			mergedPRs: metrics.mergedPRs,
			ciRuns: metrics.ciRuns,
			extLines: extLinesRecord,
			collectedAt: new Date().toISOString(),
		};

		if (isDryRun) {
			process.stdout.write(
				`[dry-run] ${filePath}:\n${JSON.stringify(perRepoData, null, 2)}\n`,
			);
		} else {
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, `${JSON.stringify(perRepoData, null, 2)}\n`);
			console.error(`[${displayName}] Written to ${filePath}`);
		}
	}

	// repositories/ 以下を全読み込み（手動追加ファイル含む）
	const allRepoMetrics = isDryRun ? collectedInThisRun : readAllPerRepoFiles();

	const aggregated = aggregateMetrics(allRepoMetrics);
	const languages = calcLanguages(aggregated.extLines);

	const result: MetricsResult = {
		addedLines: aggregated.addedLines,
		deletedLines: aggregated.deletedLines,
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

async function mainLocal(
	localPath: string,
	outputPath?: string,
): Promise<void> {
	const absPath = resolve(localPath);

	if (!existsSync(absPath)) {
		console.error(`Error: パスが存在しません: ${absPath}`);
		process.exit(1);
	}

	if (!existsSync(join(absPath, ".git"))) {
		console.error(`Error: git リポジトリではありません: ${absPath}`);
		process.exit(1);
	}

	const portalConfig = loadConfig();
	const author = portalConfig.author;

	const metrics = await collectSingleRepo({ repo: "local" }, author, absPath);

	const extLinesRecord: Record<string, number> = {};
	for (const [k, v] of metrics.extLines) {
		extLinesRecord[k] = v;
	}

	const perRepoData: PerRepoFileData = {
		cacheKey: "",
		addedLines: metrics.addedLines,
		deletedLines: metrics.deletedLines,
		commits: metrics.commits,
		mergedPRs: metrics.mergedPRs,
		ciRuns: metrics.ciRuns,
		extLines: extLinesRecord,
		collectedAt: new Date().toISOString(),
	};

	const json = `${JSON.stringify(perRepoData, null, 2)}\n`;

	if (outputPath) {
		const absOutput = resolve(outputPath);
		mkdirSync(dirname(absOutput), { recursive: true });
		writeFileSync(absOutput, json);
		console.error(`Written to ${absOutput}`);
	} else {
		process.stdout.write(json);
	}
}

if (args.local) {
	mainLocal(args.local, args.output).catch((err) => {
		console.error(err);
		process.exit(1);
	});
} else {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
