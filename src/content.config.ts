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
		url: z.string().url().optional(),
	}),
});

const ZENN_USERNAME = "happy_onigiri";
const ZENN_API_BASE = `https://zenn.dev/api/articles?username=${ZENN_USERNAME}&order=latest`;
const ZENN_JSON_FILE = "src/data/articles/zenn.json";

const zennArticleSchema = z.object({
	id: z.number(),
	title: z.string(),
	slug: z.string(),
	emoji: z.string(),
	article_type: z.string(),
	published_at: z.string(),
});

type ZennArticle = z.infer<typeof zennArticleSchema>;

async function fetchAllZennArticles(logger: {
	warn: (s: string) => void;
}): Promise<ZennArticle[] | null> {
	const articles: ZennArticle[] = [];
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
				const parsed = zennArticleSchema.safeParse(item);
				if (parsed.success) articles.push(parsed.data);
				else logger.warn(`Zenn article schema error: ${parsed.error.message}`);
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

const zennArticles = defineCollection({
	loader: {
		name: "zenn-api-loader",
		load: async ({ config, store, parseData, logger }) => {
			const jsonUrl = new URL(ZENN_JSON_FILE, config.root);
			const jsonPath = fileURLToPath(jsonUrl);

			let articles = await fetchAllZennArticles(logger);

			if (articles !== null) {
				// published_at 降順でソートして JSON に書き出す
				articles.sort(
					(a, b) =>
						new Date(b.published_at).getTime() -
						new Date(a.published_at).getTime(),
				);
				await fs.mkdir(new URL("src/data/articles/", config.root).pathname, {
					recursive: true,
				});
				await fs.writeFile(
					jsonPath,
					`${JSON.stringify(articles, null, "\t")}\n`,
					"utf-8",
				);
				logger.info(
					`Saved ${articles.length} Zenn articles to ${ZENN_JSON_FILE}`,
				);
			} else if (existsSync(jsonUrl)) {
				// API 失敗時は既存 JSON からフォールバック
				logger.warn(`Falling back to cached ${ZENN_JSON_FILE}`);
				const raw = await fs.readFile(jsonPath, "utf-8");
				articles = JSON.parse(raw) as ZennArticle[];
			} else {
				logger.warn("No Zenn articles available.");
				return;
			}

			store.clear();
			for (const article of articles) {
				const id = String(article.id);
				const data = await parseData({ id, data: article });
				store.set({ id, data });
			}
		},
	},
	schema: zennArticleSchema,
});

export const collections = { projects, zennArticles };
