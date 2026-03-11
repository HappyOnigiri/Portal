import { describe, expect, it } from "vitest";
import type { Project } from "./project";
import { sortProjectsByTitle } from "./project";

describe("sortProjectsByTitle", () => {
	it("タイトル昇順で並び替える", () => {
		const projects: Project[] = [
			{
				title: "Quantum Maguro",
				description: "B",
				url: "https://example.com/b",
			},
			{
				title: "Mesugaki Pong",
				description: "A",
				url: "https://example.com/a",
			},
		];

		const sorted = sortProjectsByTitle(projects);

		expect(sorted.map((project) => project.title)).toEqual([
			"Mesugaki Pong",
			"Quantum Maguro",
		]);
	});

	it("元配列を破壊しない", () => {
		const projects: Project[] = [
			{
				title: "B",
				description: "B",
				url: "https://example.com/b",
			},
			{
				title: "A",
				description: "A",
				url: "https://example.com/a",
			},
		];

		const original = [...projects];
		sortProjectsByTitle(projects);

		expect(projects).toEqual(original);
	});
});
