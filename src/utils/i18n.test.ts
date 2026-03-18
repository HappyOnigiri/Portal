// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Resources } from "./i18n";
import { initI18n } from "./i18n";
import { translations } from "./translations";

const mockResources: Resources = {
	ja: {
		greeting: "こんにちは",
		"nav.home": "ホーム",
	},
	en: {
		greeting: "Hello",
		"nav.home": "Home",
	},
};

// localStorage のモック
let store: Record<string, string> = {};
const localStorageMock = {
	getItem: (key: string) => store[key] ?? null,
	setItem: (key: string, val: string) => {
		store[key] = val;
	},
	removeItem: (key: string) => {
		delete store[key];
	},
	clear: () => {
		store = {};
	},
};

vi.stubGlobal("localStorage", localStorageMock);

function setup(resources: Resources = mockResources) {
	(
		globalThis as typeof globalThis & { __portalI18nResources?: Resources }
	).__portalI18nResources = resources;
}

beforeEach(() => {
	store = {};
	document.body.innerHTML = "";
	document.documentElement.lang = "ja";
});

describe("initI18n - 言語検出", () => {
	it("localStorage に 'en' が保存されていれば英語になる", () => {
		store["portal-lang"] = "en";
		setup();
		initI18n();
		expect(document.documentElement.lang).toBe("en");
	});

	it("localStorage に 'ja' が保存されていれば日本語になる", () => {
		store["portal-lang"] = "ja";
		setup();
		initI18n();
		expect(document.documentElement.lang).toBe("ja");
	});

	it("localStorage が空で navigator.language が 'ja' なら日本語になる", () => {
		vi.stubGlobal("navigator", { language: "ja-JP" });
		setup();
		initI18n();
		expect(document.documentElement.lang).toBe("ja");
	});

	it("localStorage が空で navigator.language が 'en' なら英語になる", () => {
		vi.stubGlobal("navigator", { language: "en-US" });
		setup();
		initI18n();
		expect(document.documentElement.lang).toBe("en");
	});
});

describe("initI18n - data-i18n テキスト切り替え", () => {
	it("現在の言語に対応するテキストを設定する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<p data-i18n="greeting"></p>`;
		setup();
		initI18n();
		expect(document.querySelector("[data-i18n]")?.textContent).toBe("Hello");
	});

	it("日本語では日本語テキストを設定する", () => {
		store["portal-lang"] = "ja";
		document.body.innerHTML = `<p data-i18n="greeting"></p>`;
		setup();
		initI18n();
		expect(document.querySelector("[data-i18n]")?.textContent).toBe(
			"こんにちは",
		);
	});

	it("現在の言語にキーがなくても英語にあればフォールバックする", () => {
		store["portal-lang"] = "ja";
		const resources: Resources = {
			ja: {},
			en: { "only.en": "English only" },
		};
		document.body.innerHTML = `<p data-i18n="only.en"></p>`;
		setup(resources);
		initI18n();
		expect(document.querySelector("[data-i18n]")?.textContent).toBe(
			"English only",
		);
	});

	it("どちらの言語にもキーがない場合はキー文字列を表示する", () => {
		store["portal-lang"] = "ja";
		document.body.innerHTML = `<p data-i18n="no.such.key"></p>`;
		setup();
		initI18n();
		expect(document.querySelector("[data-i18n]")?.textContent).toBe(
			"no.such.key",
		);
	});

	it("data-i18n-html は innerHTML で設定する", () => {
		store["portal-lang"] = "en";
		const resources: Resources = {
			ja: { content: "<b>日本語</b>" },
			en: { content: "<b>English</b>" },
		};
		document.body.innerHTML = `<div data-i18n="content" data-i18n-html></div>`;
		setup(resources);
		initI18n();
		expect(document.querySelector("[data-i18n]")?.innerHTML).toBe(
			"<b>English</b>",
		);
	});
});

describe("initI18n - data-lang-ja / data-lang-en 切り替え", () => {
	it("英語設定時は data-lang-en のテキストを表示する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<h2 data-lang-ja="プロジェクト" data-lang-en="Project">プロジェクト</h2>`;
		setup();
		initI18n();
		expect(document.querySelector("h2")?.textContent).toBe("Project");
	});

	it("日本語設定時は data-lang-ja のテキストを表示する", () => {
		store["portal-lang"] = "ja";
		document.body.innerHTML = `<h2 data-lang-ja="プロジェクト" data-lang-en="Project">Project</h2>`;
		setup();
		initI18n();
		expect(document.querySelector("h2")?.textContent).toBe("プロジェクト");
	});

	it("data-lang-en がない場合は data-lang-ja をフォールバックとして使う", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<h2 data-lang-ja="タイトル">タイトル</h2>`;
		setup();
		initI18n();
		expect(document.querySelector("h2")?.textContent).toBe("タイトル");
	});
});

describe("initI18n - data-lang-ja / data-lang-en img alt 切り替え", () => {
	it("英語設定時は img の alt を data-lang-en の値に更新する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<img data-lang-ja="プロジェクトのサムネイル" data-lang-en="Project thumbnail" alt="プロジェクトのサムネイル" />`;
		setup();
		initI18n();
		expect(document.querySelector("img")?.alt).toBe("Project thumbnail");
	});

	it("日本語設定時は img の alt を data-lang-ja の値に更新する", () => {
		store["portal-lang"] = "ja";
		document.body.innerHTML = `<img data-lang-ja="プロジェクトのサムネイル" data-lang-en="Project thumbnail" alt="Project thumbnail" />`;
		setup();
		initI18n();
		expect(document.querySelector("img")?.alt).toBe("プロジェクトのサムネイル");
	});
});

describe("initI18n - data-i18n-attr 属性切り替え", () => {
	it("指定した属性を翻訳キーの値で更新する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<a data-i18n-attr="aria-label:nav.home" aria-label="ホーム">link</a>`;
		setup();
		initI18n();
		expect(document.querySelector("a")?.getAttribute("aria-label")).toBe(
			"Home",
		);
	});

	it("翻訳キーが存在しない場合はキー文字列をそのまま設定する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<a data-i18n-attr="aria-label:missing.key" aria-label="">link</a>`;
		setup();
		initI18n();
		expect(document.querySelector("a")?.getAttribute("aria-label")).toBe(
			"missing.key",
		);
	});

	it("コロンのない不正なフォーマットは無視される", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<a data-i18n-attr="aria-label" aria-label="original">link</a>`;
		setup();
		initI18n();
		// malformed format: no colon → no change expected
		expect(document.querySelector("a")?.getAttribute("aria-label")).toBe(
			"original",
		);
	});
});

describe("initI18n - translations リソース", () => {
	it("translations オブジェクトに ja と en のキーが存在する", () => {
		expect(translations.ja).toBeDefined();
		expect(translations.en).toBeDefined();
	});

	it("translations を使って initI18n が正常に動作する", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `<a data-i18n-attr="aria-label:footer.x.aria">X</a>`;
		setup(translations);
		initI18n();
		expect(document.querySelector("a")?.getAttribute("aria-label")).toBe(
			"Follow HappyOnigiri on X (Twitter)",
		);
	});
});

describe("initI18n - localStorage エラー耐性", () => {
	it("localStorage.getItem が例外を投げても navigator 言語にフォールバックする", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {},
		});
		vi.stubGlobal("navigator", { language: "ja-JP" });
		setup();
		initI18n();
		expect(document.documentElement.lang).toBe("ja");
		vi.stubGlobal("localStorage", localStorageMock);
	});

	it("localStorage.setItem が例外を投げても言語切り替えが継続する", () => {
		store["portal-lang"] = "ja";
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store[key] ?? null,
			setItem: () => {
				throw new Error("SecurityError");
			},
		});
		document.body.innerHTML = `
      <p data-i18n="greeting"></p>
      <button data-lang-btn="en">EN</button>
    `;
		setup();
		initI18n();
		(document.querySelector("[data-lang-btn='en']") as HTMLElement).click();
		expect(document.documentElement.lang).toBe("en");
		expect(document.querySelector("[data-i18n]")?.textContent).toBe("Hello");
		vi.stubGlobal("localStorage", localStorageMock);
	});
});

describe("initI18n - 言語スイッチャーボタン", () => {
	it("現在の言語に対応するボタンに active クラスが付く", () => {
		store["portal-lang"] = "en";
		document.body.innerHTML = `
      <button data-lang-btn="en">EN</button>
      <button data-lang-btn="ja">JP</button>
    `;
		setup();
		initI18n();
		expect(
			document
				.querySelector("[data-lang-btn='en']")
				?.classList.contains("active"),
		).toBe(true);
		expect(
			document
				.querySelector("[data-lang-btn='ja']")
				?.classList.contains("active"),
		).toBe(false);
	});

	it("ボタンをクリックすると言語が切り替わり localStorage に保存される", () => {
		store["portal-lang"] = "ja";
		document.body.innerHTML = `
      <p data-i18n="greeting"></p>
      <button data-lang-btn="en">EN</button>
      <button data-lang-btn="ja">JP</button>
    `;
		setup();
		initI18n();

		(document.querySelector("[data-lang-btn='en']") as HTMLElement).click();

		expect(store["portal-lang"]).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		expect(document.querySelector("[data-i18n]")?.textContent).toBe("Hello");
	});
});
