import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
import { z } from "astro/zod";

const projects = defineCollection({
	loader: file("src/content/projects.yaml"),
	schema: z.object({
		id: z.string(),
		title: z.string(),
		title_en: z.string().optional(),
		description: z.string(),
		description_en: z.string().optional(),
		image: z.string().optional(),
		url: z.string().url().optional(),
	}),
});

export const collections = { projects };
