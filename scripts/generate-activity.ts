import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ActivityData,
	type ActivitySnapshot,
	buildActivityData,
} from "../src/utils/activity.ts";

const DEFAULT_REPOSITORY_DATA_DIR = resolve(
	process.cwd(),
	"src/data/repositories",
);
const DEFAULT_OUTPUT_PATH = resolve(process.cwd(), "src/data/activity.json");
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
type GitRunner = (args: string[], cwd: string) => string;

function listJsonFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	function walk(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const fullPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				files.push(fullPath);
			}
		}
	}
	walk(root);
	return files.sort();
}

function runGit(args: string[], cwd: string): string {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const variable of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_PREFIX",
	]) {
		delete environment[variable];
	}
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
		env: environment,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSnapshot(
	content: string,
	committedAt: string,
): ActivitySnapshot | null {
	try {
		const value: unknown = JSON.parse(content);
		if (!isRecord(value)) return null;
		const fields = [
			"addedLines",
			"deletedLines",
			"commits",
			"mergedPRs",
			"ciRuns",
		];
		if (
			fields.some(
				(field) =>
					typeof value[field] !== "number" ||
					!Number.isFinite(value[field] as number),
			)
		) {
			return null;
		}
		return {
			committedAt,
			changedLines:
				(value.addedLines as number) + (value.deletedLines as number),
			commits: value.commits as number,
			mergedPRs: value.mergedPRs as number,
			ciRuns: value.ciRuns as number,
		};
	} catch {
		return null;
	}
}

/** 現在存在する JSON だけを対象に、各ファイルの有効な履歴スナップショットを読む。 */
export function collectActivitySnapshots(
	repositoryDataDir = DEFAULT_REPOSITORY_DATA_DIR,
	gitCwd = process.cwd(),
	gitRunner: GitRunner = runGit,
): ActivitySnapshot[][] {
	return listJsonFiles(repositoryDataDir).map((filePath) => {
		const relativePath = relative(gitCwd, filePath).split(sep).join("/");
		let log = "";
		try {
			log = gitRunner(
				[
					"log",
					"--follow",
					"--format=%H%x09%cI",
					"--diff-filter=AMCR",
					"--",
					relativePath,
				],
				gitCwd,
			);
		} catch {
			return [];
		}

		const snapshots: ActivitySnapshot[] = [];
		const seenCommits = new Set<string>();
		for (const line of log.split("\n")) {
			const [hash, committedAt] = line.trim().split("\t");
			if (!hash || !committedAt || seenCommits.has(hash)) continue;
			seenCommits.add(hash);
			try {
				const content = gitRunner(["show", `${hash}:${relativePath}`], gitCwd);
				const snapshot = readSnapshot(content, committedAt);
				if (snapshot) snapshots.push(snapshot);
			} catch {
				// リネーム前のパスなど、対象コミットでファイルを読めない履歴は無視する。
			}
		}
		return snapshots.reverse();
	});
}

export function generateActivity(
	outputPath = DEFAULT_OUTPUT_PATH,
	repositoryDataDir = DEFAULT_REPOSITORY_DATA_DIR,
	gitCwd = process.cwd(),
): ActivityData {
	const snapshots = collectActivitySnapshots(repositoryDataDir, gitCwd);
	const data = buildActivityData(snapshots);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(data, null, "\t")}\n`);
	return data;
}

function main(): void {
	const data = generateActivity();
	console.log(
		`アクティビティデータを生成しました: ${data.daily.length} 日 / ${data.monthly.length} ヶ月`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
