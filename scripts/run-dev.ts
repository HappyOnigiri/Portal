import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { relative, resolve } from "node:path";

const projectRoot = process.cwd();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const forwardedArgs = process.argv.slice(2);
const ignoredPathPrefixes = [
	".astro/",
	".git/",
	"coverage/",
	"dist/",
	"node_modules/",
	"tmp/",
	"src/data/articles/",
];
const ignoredExactPaths = new Set(["src/data/author-status.json"]);
const recoverableErrorPatterns = [
	/Cannot read properties of undefined \(reading 'call'\)/,
	/Failed to load url .* Does the file exist\?/,
	/transport was disconnected, cannot call "fetchModule"/,
	/Vite module runner has been closed\./,
	/Could not import `\/src\/.*`\./,
];

let child: ReturnType<typeof spawn> | null = null;
let broken = false;
let shuttingDown = false;
let restartTimer: NodeJS.Timeout | null = null;

function normalizePath(filePath: string): string {
	return filePath.split("\\").join("/");
}

function shouldIgnore(filePath: string): boolean {
	return (
		ignoredExactPaths.has(filePath) ||
		ignoredPathPrefixes.some((prefix) => filePath.startsWith(prefix))
	);
}

function markBroken(reason: string): void {
	if (broken) return;
	broken = true;
	console.error(
		`[run-dev-watch] 開発サーバーの再起動待ち状態に入りました: ${reason}`,
	);
	console.error(
		"[run-dev-watch] 次のファイル変更を検知したら astro dev を再起動します。",
	);
}

function scanOutput(chunk: string): void {
	for (const pattern of recoverableErrorPatterns) {
		if (pattern.test(chunk)) {
			markBroken(chunk.trim().split("\n")[0] ?? "dev server error");
			return;
		}
	}
}

function stopChild(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
	return new Promise((resolveStop) => {
		if (!child || child.exitCode !== null) {
			child = null;
			resolveStop();
			return;
		}

		const currentChild = child;
		const timeout = setTimeout(() => {
			if (currentChild.exitCode === null) {
				currentChild.kill("SIGKILL");
			}
		}, 2_000);

		currentChild.once("exit", () => {
			clearTimeout(timeout);
			if (child === currentChild) {
				child = null;
			}
			resolveStop();
		});

		currentChild.kill(signal);
	});
}

function startChild(): void {
	broken = false;
	const nextChild = spawn(
		pnpmCommand,
		[
			"run",
			"dev:raw",
			...(forwardedArgs.length > 0 ? ["--", ...forwardedArgs] : []),
		],
		{
			cwd: projectRoot,
			env: { ...process.env, FORCE_COLOR: "1" },
			stdio: ["inherit", "pipe", "pipe"],
		},
	);
	child = nextChild;

	nextChild.stdout.on("data", (data: Buffer) => {
		const text = data.toString();
		process.stdout.write(text);
		scanOutput(text);
	});

	nextChild.stderr.on("data", (data: Buffer) => {
		const text = data.toString();
		process.stderr.write(text);
		scanOutput(text);
	});

	nextChild.once("exit", (code, signal) => {
		if (child === nextChild) {
			child = null;
		}
		if (shuttingDown) {
			process.exit(code ?? (signal ? 1 : 0));
		}
		if (code !== 0) {
			markBroken(
				`dev server exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
			);
		}
	});
}

async function restartChild(changedPath: string): Promise<void> {
	console.error(
		`[run-dev-watch] ${changedPath} の変更を検知したため astro dev を再起動します。`,
	);
	await stopChild();
	if (!shuttingDown) {
		startChild();
	}
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
	shuttingDown = true;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	await stopChild(signal);
	process.exit(0);
}

const watcher = watch(
	projectRoot,
	{ persistent: true, recursive: true },
	(eventType, filename) => {
		if (!broken || !filename) return;

		const relativePath = normalizePath(
			relative(projectRoot, resolve(projectRoot, filename)),
		);
		if (!relativePath || relativePath.startsWith("../")) return;
		if (shouldIgnore(relativePath)) return;

		if (restartTimer) {
			clearTimeout(restartTimer);
		}

		restartTimer = setTimeout(
			() => {
				restartTimer = null;
				void restartChild(relativePath);
			},
			eventType === "rename" ? 150 : 75,
		);
	},
);

watcher.on("error", (error) => {
	console.error("[run-dev-watch] ファイル監視でエラーが発生しました。");
	console.error(error);
});

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});

startChild();
