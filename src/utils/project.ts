import type { CollectionEntry } from "astro:content";

export type Project = CollectionEntry<"projects">["data"];

export function sortProjectsByTitle(projects: Project[]): Project[] {
	return [...projects].sort((a, b) => a.title.localeCompare(b.title, "ja"));
}
