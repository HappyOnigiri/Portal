export type Language = "ja" | "en";
export type Translations = Record<string, string>;
export type Resources = Record<Language, Translations>;

const STORAGE_KEY = "portal-lang";

function detectLanguage(): Language {
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(STORAGE_KEY);
	} catch {
		// Ignore storage errors (e.g., restricted environments)
	}
	if (saved === "ja" || saved === "en") return saved;
	return navigator.language.startsWith("ja") ? "ja" : "en";
}

let currentLang: Language = "en";
let resources: Resources = { ja: {}, en: {} };

function updatePage(): void {
	document.documentElement.lang = currentLang;

	// data-lang-ja / data-lang-en 属性を持つ要素を切り替え
	for (const el of document.querySelectorAll<HTMLElement>("[data-lang-ja]")) {
		const jaText = el.getAttribute("data-lang-ja") ?? "";
		const enText = el.getAttribute("data-lang-en") ?? jaText;
		el.textContent = currentLang === "ja" ? jaText : enText;
	}

	// data-i18n によるテキスト切り替え
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
		const key = el.getAttribute("data-i18n");
		if (!key) continue;
		const text = resources[currentLang]?.[key] ?? resources.en?.[key] ?? key;
		if (el.hasAttribute("data-i18n-html")) {
			el.innerHTML = text;
		} else {
			el.textContent = text;
		}
	}

	// data-i18n-attr による属性切り替え
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-attr]")) {
		const attrDef = el.getAttribute("data-i18n-attr");
		if (!attrDef) continue;
		for (const part of attrDef.split(",")) {
			const [attrName, key] = part.split(":");
			if (attrName && key) {
				const text =
					resources[currentLang]?.[key.trim()] ??
					resources.en?.[key.trim()] ??
					key.trim();
				el.setAttribute(attrName.trim(), text);
			}
		}
	}

	// ボタンの active クラスを更新
	for (const btn of document.querySelectorAll<HTMLElement>("[data-lang-btn]")) {
		btn.classList.toggle(
			"active",
			btn.getAttribute("data-lang-btn") === currentLang,
		);
	}
}

function setLanguage(lang: Language): void {
	currentLang = lang;
	try {
		localStorage.setItem(STORAGE_KEY, lang);
	} catch {
		// Ignore storage errors (e.g., restricted environments)
	}
	updatePage();
}

function setupLanguageButtons(): void {
	for (const btn of document.querySelectorAll<HTMLElement>("[data-lang-btn]")) {
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			const lang = btn.getAttribute("data-lang-btn") as Language;
			if (lang) setLanguage(lang);
		});
	}
}

export function initI18n(): void {
	const g = globalThis as typeof globalThis & {
		__portalI18nResources?: Resources;
	};
	resources = g.__portalI18nResources ?? { ja: {}, en: {} };
	currentLang = detectLanguage();
	updatePage();
	setupLanguageButtons();
}
