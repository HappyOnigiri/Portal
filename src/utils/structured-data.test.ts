import { describe, expect, it } from "vitest";
import type { Project } from "./project";
import {
	breadcrumbList,
	buildJsonLdGraph,
	collectionPageArticles,
	itemListProjects,
	itemListZennArticles,
	personHappyOnigiri,
	softwareApplicationProject,
	toAbsoluteUrl,
	webSiteRoot,
} from "./structured-data";

const ORIGIN = "https://onigiri-portal.vercel.app";

describe("structured-data", () => {
	it("toAbsoluteUrl は相対パスを絶対 URL にする", () => {
		expect(toAbsoluteUrl(ORIGIN, "/foo")).toBe(`${ORIGIN}/foo`);
		expect(toAbsoluteUrl(`${ORIGIN}/`, "/foo")).toBe(`${ORIGIN}/foo`);
		expect(toAbsoluteUrl(ORIGIN, "rel")).toBe(`${ORIGIN}/rel`);
	});

	it("toAbsoluteUrl は既に絶対の URL をそのまま返す", () => {
		expect(toAbsoluteUrl(ORIGIN, "https://b.test/x")).toBe("https://b.test/x");
		expect(toAbsoluteUrl(ORIGIN, "http://b.test/x")).toBe("http://b.test/x");
	});

	it("buildJsonLdGraph は @context と @graph を付与する", () => {
		const g = buildJsonLdGraph([{ "@type": "Thing", name: "x" }]);
		expect(g["@context"]).toBe("https://schema.org");
		expect(Array.isArray(g["@graph"])).toBe(true);
		expect((g["@graph"] as unknown[])[0]).toEqual({
			"@type": "Thing",
			name: "x",
		});
	});

	it("personHappyOnigiri / webSiteRoot は末尾スラッシュ付き origin でも正規化する", () => {
		const p = personHappyOnigiri(`${ORIGIN}/`);
		expect(p["@id"]).toBe(`${ORIGIN}/#person`);
		expect(p.url).toBe(`${ORIGIN}/`);

		const w = webSiteRoot(`${ORIGIN}/`, "説明");
		expect(w["@id"]).toBe(`${ORIGIN}/#website`);
		expect(w.description).toBe("説明");
	});

	it("itemListProjects はプロジェクト URL を列挙する", () => {
		const list = itemListProjects(ORIGIN, [
			{ id: "a", title: "A", description: "d" },
		]);
		const elements = list.itemListElement as Record<string, unknown>[];
		expect(elements[0]?.item).toBe(`${ORIGIN}/projects/a`);
		expect(list.numberOfItems).toBe(1);
	});

	it("itemListZennArticles は Zenn の記事 URL を列挙する", () => {
		const list = itemListZennArticles([{ title: "A", slug: "a-slug" }]);
		const elements = list.itemListElement as Record<string, unknown>[];
		expect(elements[0]?.item).toBe(
			"https://zenn.dev/happy_onigiri/articles/a-slug",
		);
	});

	it("breadcrumbList はパンくず用の絶対 URL を返す", () => {
		const b = breadcrumbList(`${ORIGIN}/`, [
			{ name: "トップ", path: "/" },
			{ name: "一覧", path: "/projects" },
		]);
		const els = b.itemListElement as Record<string, unknown>[];
		expect(els[0]?.item).toBe(`${ORIGIN}/`);
		expect(els[1]?.item).toBe(`${ORIGIN}/projects`);
	});

	it("collectionPageArticles は記事一覧ページ用ノードを返す", () => {
		const c = collectionPageArticles(ORIGIN, "記事の説明");
		expect(c["@type"]).toBe("CollectionPage");
		expect(c["@id"]).toBe(`${ORIGIN}/articles#webpage`);
		expect(c.url).toBe(`${ORIGIN}/articles`);
		expect(c.description).toBe("記事の説明");
	});

	it("softwareApplicationProject はカテゴリと画像・外部 url を反映する", () => {
		const base: Project = {
			id: "x",
			order: 1,
			title: "T",
			description: "D",
		};
		const game: Project = {
			...base,
			category: "GAME",
			image: "/img.png",
			url: "https://game.example/play",
		};
		const g = softwareApplicationProject(ORIGIN, game, "/projects/x");
		expect(g.applicationCategory).toBe("GameApplication");
		expect(g.url).toBe("https://game.example/play");
		expect(g.image).toBe(`${ORIGIN}/img.png`);

		const tool: Project = { ...base, category: "TOOL" };
		const t = softwareApplicationProject(ORIGIN, tool, "/projects/x");
		expect(t.applicationCategory).toBe("DeveloperApplication");

		const plugin: Project = { ...base, category: "PLUGIN" };
		const pl = softwareApplicationProject(ORIGIN, plugin, "/projects/x");
		expect(pl.applicationCategory).toBe("SoftwareApplication");

		const noImg: Project = { ...base };
		const n = softwareApplicationProject(ORIGIN, noImg, "/projects/x");
		expect(n.image).toBeUndefined();
		expect(n.url).toBe(`${ORIGIN}/projects/x`);
	});
});
