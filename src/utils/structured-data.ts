import type { Project } from "./project";

export function buildJsonLdGraph(
	nodes: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		"@context": "https://schema.org",
		"@graph": nodes,
	};
}

export function toAbsoluteUrl(siteOrigin: string, path: string): string {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	const base = siteOrigin.endsWith("/") ? siteOrigin.slice(0, -1) : siteOrigin;
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${base}${p}`;
}

const PERSON_ID_SUFFIX = "/#person";

export function personHappyOnigiri(
	siteOrigin: string,
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	return {
		"@type": "Person",
		"@id": `${origin}${PERSON_ID_SUFFIX}`,
		name: "HappyOnigiri",
		url: `${origin}/`,
		sameAs: [
			"https://x.com/H_OnigiriWorks",
			"https://github.com/HappyOnigiri",
			"https://zenn.dev/happy_onigiri",
			"https://note.com/happy_onigiri",
		],
	};
}

export function webSiteRoot(
	siteOrigin: string,
	description: string,
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	return {
		"@type": "WebSite",
		"@id": `${origin}/#website`,
		url: `${origin}/`,
		name: "ONIGIRI PORTAL",
		description,
		inLanguage: "ja",
		publisher: { "@id": `${origin}${PERSON_ID_SUFFIX}` },
	};
}

export function itemListProjects(
	siteOrigin: string,
	projects: Pick<Project, "id" | "title" | "description">[],
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	return {
		"@type": "ItemList",
		"@id": `${origin}/#project-list`,
		numberOfItems: projects.length,
		itemListElement: projects.map((p, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: p.title,
			item: `${origin}/projects/${p.id}`,
		})),
	};
}

function applicationCategoryForProject(category: string | undefined): string {
	if (category === "GAME") return "GameApplication";
	if (category === "TOOL") return "DeveloperApplication";
	return "SoftwareApplication";
}

export function softwareApplicationProject(
	siteOrigin: string,
	project: Project,
	detailPath: string,
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	const canonical = `${origin}${detailPath}`;
	const image = project.image
		? toAbsoluteUrl(siteOrigin, project.image)
		: undefined;
	const appUrl = project.url ?? canonical;
	const node: Record<string, unknown> = {
		"@type": "SoftwareApplication",
		"@id": `${canonical}#software`,
		name: project.title,
		description: project.description,
		url: appUrl,
		applicationCategory: applicationCategoryForProject(project.category),
		operatingSystem: "Web",
		author: { "@id": `${origin}${PERSON_ID_SUFFIX}` },
	};
	if (image) node.image = image;
	return node;
}

export function breadcrumbList(
	siteOrigin: string,
	items: { name: string; path: string }[],
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	return {
		"@type": "BreadcrumbList",
		itemListElement: items.map((item, i) => ({
			"@type": "ListItem",
			position: i + 1,
			name: item.name,
			item: `${origin}${item.path}`,
		})),
	};
}

export function itemListArticles(
	articles: { title: string; slug: string; url: string }[],
): Record<string, unknown> {
	return {
		"@type": "ItemList",
		numberOfItems: articles.length,
		itemListElement: articles.map((a, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: a.title,
			item: a.url,
		})),
	};
}

export function collectionPageArticles(
	siteOrigin: string,
	description: string,
): Record<string, unknown> {
	const origin = siteOrigin.endsWith("/")
		? siteOrigin.slice(0, -1)
		: siteOrigin;
	return {
		"@type": "CollectionPage",
		"@id": `${origin}/articles#webpage`,
		url: `${origin}/articles`,
		name: "記事一覧 | ONIGIRI PORTAL",
		description,
		isPartOf: { "@id": `${origin}/#website` },
		author: { "@id": `${origin}${PERSON_ID_SUFFIX}` },
	};
}
