import { defineCollection } from "astro:content";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "astro/zod";
import { parse } from "yaml";

const FILE_NAME = "src/content/projects.yaml";

const projects = defineCollection({
	loader: {
		name: "projects-yaml-loader",
		load: async ({ config, store, parseData, logger, watcher }) => {
			const url = new URL(FILE_NAME, config.root);
			if (!existsSync(url)) {
				logger.error(`File not found: ${FILE_NAME}`);
				return;
			}
			const filePath = fileURLToPath(url);

			async function syncData() {
				const raw = await fs.readFile(filePath, "utf-8");
				const items = parse(raw) as Array<Record<string, unknown>>;
				const parsed: Array<{
					id: string;
					data: Awaited<ReturnType<typeof parseData>>;
				}> = [];
				for (const [i, item] of items.entries()) {
					const id = String(item.id);
					const data = await parseData({
						id,
						data: { ...item, order: i + 1 },
						filePath,
					});
					parsed.push({ id, data });
				}
				store.clear();
				for (const { id, data } of parsed) {
					store.set({ id, data });
				}
			}

			await syncData();

			watcher?.add(filePath);
			let reloadTask = Promise.resolve();
			watcher?.on("change", (changedPath) => {
				if (changedPath === filePath) {
					logger.info(`Reloading data from ${FILE_NAME}`);
					reloadTask = reloadTask.then(() =>
						syncData().catch((err) => {
							logger.error(`Failed to reload ${FILE_NAME}: ${err}`);
						}),
					);
				}
			});
		},
	},
	schema: z.object({
		id: z.string(),
		order: z.number(),
		title: z.string(),
		title_en: z.string().optional(),
		description: z.string(),
		description_en: z.string().optional(),
		image: z.string().optional(),
		image_fit: z.enum(["cover", "contain"]).default("cover"),
		image_contain_bg: z.string().optional(),
		url: z.string().url().optional(),
		category: z.string().optional(),
		category_color: z.string().optional(),
	}),
});

const ZENN_USERNAME = "happy_onigiri";
const ZENN_API_BASE = `https://zenn.dev/api/articles?username=${ZENN_USERNAME}&order=latest`;
const ZENN_JSON_FILE = "src/data/articles/zenn.json";

const NOTE_USERNAME = "happy_onigiri";
const NOTE_API_BASE = `https://note.com/api/v2/creators/${NOTE_USERNAME}/contents?kind=note`;
const NOTE_JSON_FILE = "src/data/articles/note.json";

const articleSchema = z.object({
	id: z.number(),
	title: z.string(),
	title_en: z.string().optional(),
	slug: z.string(),
	emoji: z.string().optional(),
	article_type: z.string().optional(),
	published_at: z.string(),
	platform: z.enum(["zenn", "note"]),
	url: z.string(),
});

type Article = z.infer<typeof articleSchema>;

// Zenn API レスポンス用の内部スキーマ
const zennApiSchema = z.object({
	id: z.number(),
	title: z.string(),
	slug: z.string(),
	emoji: z.string(),
	article_type: z.string(),
	published_at: z.string(),
});

async function fetchAllZennArticles(logger: {
	warn: (s: string) => void;
}): Promise<Article[] | null> {
	const articles: Article[] = [];
	let page = 1;
	try {
		while (true) {
			const res = await fetch(`${ZENN_API_BASE}&page=${page}`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				logger.warn(`Zenn API returned ${res.status} on page ${page}`);
				return null;
			}
			const json = (await res.json()) as {
				articles?: unknown[];
				next_page: number | null;
			};
			const items = Array.isArray(json.articles) ? json.articles : [];
			for (const item of items) {
				const parsed = zennApiSchema.safeParse(item);
				if (parsed.success) {
					articles.push({
						...parsed.data,
						platform: "zenn",
						url: `https://zenn.dev/${ZENN_USERNAME}/articles/${parsed.data.slug}`,
					});
				} else {
					logger.warn(`Zenn article schema error: ${parsed.error.message}`);
				}
			}
			if (json.next_page === null) break;
			page = json.next_page;
		}
		return articles;
	} catch (err) {
		logger.warn(`Failed to fetch Zenn articles: ${err}`);
		return null;
	}
}

async function fetchAllNoteArticles(logger: {
	warn: (s: string) => void;
}): Promise<Article[] | null> {
	const articles: Article[] = [];
	let page = 1;
	try {
		while (true) {
			const res = await fetch(`${NOTE_API_BASE}&page=${page}`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				logger.warn(`note API returned ${res.status} on page ${page}`);
				return null;
			}
			const json = (await res.json()) as {
				data?: {
					contents?: unknown[];
					isLastPage?: boolean;
				};
			};
			const items = Array.isArray(json.data?.contents)
				? json.data.contents
				: [];
			for (const item of items) {
				if (
					item &&
					typeof item === "object" &&
					"id" in item &&
					"name" in item &&
					"key" in item &&
					"publishAt" in item &&
					"noteUrl" in item
				) {
					const raw = item as Record<string, unknown>;
					articles.push({
						id: Number(raw.id),
						title: String(raw.name),
						slug: String(raw.key),
						published_at: String(raw.publishAt),
						platform: "note",
						url: String(raw.noteUrl),
					});
				} else {
					logger.warn(
						`note article missing expected fields: ${JSON.stringify(item)}`,
					);
				}
			}
			if (json.data?.isLastPage) break;
			page++;
		}
		return articles;
	} catch (err) {
		logger.warn(`Failed to fetch note articles: ${err}`);
		return null;
	}
}

const articles = defineCollection({
	loader: {
		name: "articles-loader",
		load: async ({ config, store, parseData, logger }) => {
			const zennJsonUrl = new URL(ZENN_JSON_FILE, config.root);
			const zennJsonPath = fileURLToPath(zennJsonUrl);
			const noteJsonUrl = new URL(NOTE_JSON_FILE, config.root);
			const noteJsonPath = fileURLToPath(noteJsonUrl);

			// [Policy] FETCH_ARTICLES=true（後方互換: FETCH_ZENN=true）で API 取得を有効化
			const shouldFetch =
				process.env.FETCH_ARTICLES === "true" ||
				process.env.FETCH_ZENN === "true";
			if (!shouldFetch) {
				logger.info(
					"Skipping articles API fetch (set FETCH_ARTICLES=true to enable)",
				);
			}

			// --- Zenn 記事取得 ---
			let zennArticles = shouldFetch
				? await fetchAllZennArticles(logger)
				: null;

			if (zennArticles !== null) {
				// 既存 JSON から title_en を引き継ぐ
				const existingTitleEnMap = new Map<string, string>();
				if (existsSync(zennJsonUrl)) {
					try {
						const raw = await fs.readFile(zennJsonPath, "utf-8");
						const cached = JSON.parse(raw);
						if (Array.isArray(cached)) {
							for (const a of cached) {
								if (
									a &&
									typeof a === "object" &&
									typeof a.slug === "string" &&
									typeof a.title_en === "string"
								) {
									existingTitleEnMap.set(a.slug, a.title_en);
								}
							}
						} else {
							logger.warn(
								"Zenn cache JSON is not an array; skipping title_en inheritance",
							);
						}
					} catch (err) {
						logger.warn(
							`Failed to read/parse Zenn cache; skipping title_en inheritance: ${err}`,
						);
					}
				}
				for (const article of zennArticles) {
					const cached = existingTitleEnMap.get(article.slug);
					if (cached) article.title_en = cached;
				}

				// title_en 未取得の記事をスクレイピング
				let isFirst = true;
				for (const article of zennArticles) {
					if (article.title_en) continue;
					if (!isFirst) {
						await new Promise<void>((resolve) => setTimeout(resolve, 2000));
					}
					isFirst = false;
					try {
						const res = await fetch(
							`https://zenn.dev/happy_onigiri/articles/${article.slug}?locale=en`,
							{ signal: AbortSignal.timeout(10_000) },
						);
						if (res.ok) {
							const html = await res.text();
							const match = html.match(
								/<meta property="og:title" content="([^"]+)"/,
							);
							if (match) {
								const titleEn = match[1]
									.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
										String.fromCodePoint(parseInt(hex, 16)),
									)
									.replace(/&#(\d+);/g, (_, dec) =>
										String.fromCodePoint(parseInt(dec, 10)),
									)
									.replace(/&amp;/g, "&")
									.replace(/&lt;/g, "<")
									.replace(/&gt;/g, ">")
									.replace(/&quot;/g, '"');
								if (titleEn !== article.title) {
									article.title_en = titleEn;
									logger.info(
										`Fetched English title for ${article.slug}: ${titleEn}`,
									);
								}
							}
						}
					} catch (err) {
						logger.warn(
							`Failed to fetch English title for ${article.slug}: ${err}`,
						);
					}
				}

				// published_at 降順でソートして JSON に書き出す
				zennArticles.sort(
					(a, b) =>
						new Date(b.published_at).getTime() -
						new Date(a.published_at).getTime(),
				);
				await fs.mkdir(
					fileURLToPath(new URL("src/data/articles/", config.root)),
					{ recursive: true },
				);
				await fs.writeFile(
					zennJsonPath,
					`${JSON.stringify(zennArticles, null, "\t")}\n`,
					"utf-8",
				);
				logger.info(
					`Saved ${zennArticles.length} Zenn articles to ${ZENN_JSON_FILE}`,
				);
			} else if (existsSync(zennJsonUrl)) {
				// API 失敗時は既存 JSON からフォールバック
				logger.warn(`Falling back to cached ${ZENN_JSON_FILE}`);
				try {
					const raw = await fs.readFile(zennJsonPath, "utf-8");
					const parsed = JSON.parse(raw);
					if (Array.isArray(parsed)) {
						zennArticles = parsed as Article[];
					} else {
						logger.error(
							`Cached ${ZENN_JSON_FILE} is not an array; skipping fallback`,
						);
					}
				} catch (err) {
					logger.error(`Failed to read/parse cached ${zennJsonPath}: ${err}`);
				}
			} else {
				logger.warn("No Zenn articles available.");
			}

			// platform/url が未設定のキャッシュ JSON を補完
			if (zennArticles) {
				for (const a of zennArticles) {
					if (!a.platform) a.platform = "zenn";
					if (!a.url)
						a.url = `https://zenn.dev/${ZENN_USERNAME}/articles/${a.slug}`;
				}
			}

			// --- note 記事取得 ---
			let noteArticles = shouldFetch
				? await fetchAllNoteArticles(logger)
				: null;

			if (noteArticles !== null) {
				noteArticles.sort(
					(a, b) =>
						new Date(b.published_at).getTime() -
						new Date(a.published_at).getTime(),
				);
				await fs.mkdir(
					fileURLToPath(new URL("src/data/articles/", config.root)),
					{ recursive: true },
				);
				await fs.writeFile(
					noteJsonPath,
					`${JSON.stringify(noteArticles, null, "\t")}\n`,
					"utf-8",
				);
				logger.info(
					`Saved ${noteArticles.length} note articles to ${NOTE_JSON_FILE}`,
				);
			} else if (existsSync(noteJsonUrl)) {
				// API 失敗時は既存 JSON からフォールバック
				logger.warn(`Falling back to cached ${NOTE_JSON_FILE}`);
				try {
					const raw = await fs.readFile(noteJsonPath, "utf-8");
					const parsed = JSON.parse(raw);
					if (Array.isArray(parsed)) {
						noteArticles = parsed as Article[];
					} else {
						logger.error(
							`Cached ${NOTE_JSON_FILE} is not an array; skipping fallback`,
						);
					}
				} catch (err) {
					logger.error(`Failed to read/parse cached ${noteJsonPath}: ${err}`);
				}
			} else {
				logger.warn("No note articles available.");
			}

			// platform/url が未設定のキャッシュ JSON を補完
			if (noteArticles) {
				for (const a of noteArticles) {
					if (!a.platform) a.platform = "note";
					if (!a.url) a.url = `https://note.com/${NOTE_USERNAME}/n/${a.slug}`;
				}
			}

			// 両方を結合し published_at 降順ソート
			const allArticles: Article[] = [
				...(zennArticles ?? []),
				...(noteArticles ?? []),
			].sort(
				(a, b) =>
					new Date(b.published_at).getTime() -
					new Date(a.published_at).getTime(),
			);

			if (allArticles.length === 0) {
				logger.warn("No articles available from any platform.");
				return;
			}

			store.clear();
			for (const article of allArticles) {
				// プラットフォーム間の ID 衝突を避けるため prefix を付与
				const id = `${article.platform}-${article.id}`;
				const data = await parseData({ id, data: article });
				store.set({ id, data });
			}
		},
	},
	schema: articleSchema,
});

export const collections = { projects, articles };
