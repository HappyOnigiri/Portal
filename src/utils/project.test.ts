import { describe, expect, it } from "vitest";
import type { Project } from "./project";
import { sortProjectsByOrder, sortProjectsByTitle } from "./project";

describe("sortProjectsByTitle", () => {
	it("タイトル昇順で並び替える", () => {
		const projects: Project[] = [
			{
				id: "quantum-maguro",
				order: 2,
				title: "Quantum Maguro",
				description: "B",
				url: "https://example.com/b",
				image_fit: "cover",
			},
			{
				id: "mesugaki-pong",
				order: 1,
				title: "Mesugaki Pong",
				description: "A",
				url: "https://example.com/a",
				image_fit: "cover",
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
				id: "b",
				order: 2,
				title: "B",
				description: "B",
				url: "https://example.com/b",
				image_fit: "cover",
			},
			{
				id: "a",
				order: 1,
				title: "A",
				description: "A",
				url: "https://example.com/a",
				image_fit: "cover",
			},
		];

		const original = [...projects];
		sortProjectsByTitle(projects);

		expect(projects).toEqual(original);
	});
});

describe("sortProjectsByOrder", () => {
	it("order 昇順で並び替える", () => {
		const projects: Project[] = [
			{
				id: "quantum-maguro",
				order: 3,
				title: "Quantum Maguro",
				description: "C",
				url: "https://example.com/c",
				image_fit: "cover",
			},
			{
				id: "pixel-refiner",
				order: 1,
				title: "PixelRefiner",
				description: "A",
				url: "https://example.com/a",
				image_fit: "cover",
			},
			{
				id: "mesugaki-pong",
				order: 2,
				title: "Mesugaki Pong",
				description: "B",
				url: "https://example.com/b",
				image_fit: "cover",
			},
		];

		const sorted = sortProjectsByOrder(projects);

		expect(sorted.map((p) => p.id)).toEqual([
			"pixel-refiner",
			"mesugaki-pong",
			"quantum-maguro",
		]);
	});

	it("元配列を破壊しない", () => {
		const projects: Project[] = [
			{
				id: "b",
				order: 2,
				title: "B",
				description: "B",
				url: "https://example.com/b",
				image_fit: "cover",
			},
			{
				id: "a",
				order: 1,
				title: "A",
				description: "A",
				url: "https://example.com/a",
				image_fit: "cover",
			},
		];

		const original = [...projects];
		sortProjectsByOrder(projects);

		expect(projects).toEqual(original);
	});
});
