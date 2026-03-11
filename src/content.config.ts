import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const projects = defineCollection({
	loader: glob({ pattern: "**/*.yaml", base: "./src/content/projects" }),
	schema: z.object({
		title: z.string(),
		title_en: z.string().optional(),
		description: z.string(),
		description_en: z.string().optional(),
		image: z.string().optional(),
		url: z.string().url(),
	}),
});

export const collections = { projects };
