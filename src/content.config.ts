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
			watcher?.on("change", async (changedPath) => {
				if (changedPath === filePath) {
					logger.info(`Reloading data from ${FILE_NAME}`);
					await syncData();
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

export const collections = { projects };
