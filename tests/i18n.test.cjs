"use strict";
/**
 * The i18n table.
 *
 * The failure this guards is invisible in testing-by-eye: a key present in one
 * language and missing from the other only shows up when a user switches, and
 * then it shows up as a raw `rotation.countdown` in the UI. So the table is
 * checked structurally instead.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { NS, TABLE, createTranslator, dictionaries, keys } = require("../src/i18n.cjs");

test("every key carries both languages, non-empty", () => {
	for (const [key, pair] of Object.entries(TABLE)) {
		assert.ok(Array.isArray(pair) && pair.length === 2, `${key} is not a [zh, en] pair`);
		assert.equal(typeof pair[0], "string");
		assert.equal(typeof pair[1], "string");
		assert.ok(pair[0].trim().length > 0, `${key} has an empty Chinese string`);
		assert.ok(pair[1].trim().length > 0, `${key} has an empty English string`);
	}
});

test("the English mirror is actually English", () => {
	// A copy-paste that left Chinese in the English slot is the realistic bug.
	let checked = 0;
	for (const [key, pair] of Object.entries(TABLE)) {
		if (key === "appearance.fit.blur") continue; // legitimately "Contain + bleed"
		assert.ok(!/[\u4e00-\u9fff]/.test(pair[1]), `${key} has Chinese in its English string`);
		checked += 1;
	}
	assert.ok(checked > 40, `only ${checked} keys were checked`);
});

/**
 * Keys whose string is language-neutral on purpose: a literal URL or a symbol
 * reads the same in both languages, so forcing Chinese into it would print a
 * *worse* hint. Kept as an explicit list rather than a loose matcher so the
 * exemption has to be argued for one key at a time.
 */
const NEUTRAL_KEYS = new Set(["custom.url.placeholder"]);

/** A URL or a bare file name — anything that is an address, not prose. */
const ADDRESS_LIKE = /https?:\/\/\S+|[\w-]+\.(?:jpg|jpeg|png|webp|avif|gif)\b|\S+:\/\/\S+/g;

test("the Chinese column carries Chinese", () => {
	// Proper nouns and units are allowed to be ASCII; the *majority* must not be.
	let checked = 0;
	for (const [key, pair] of Object.entries(TABLE)) {
		if (/^status\./.test(key)) continue;
		checked += 1;
		if (NEUTRAL_KEYS.has(key)) {
			// The exemption is only valid while the value really is an address:
			// strip everything URL-shaped and no words may be left over.
			const residue = pair[0].replace(ADDRESS_LIKE, "").trim();
			assert.equal(residue, "", `${key} is listed as language-neutral but reads as prose: ${residue}`);
			continue;
		}
		const hasChinese = /[\u4e00-\u9fff]/.test(pair[0]);
		assert.ok(hasChinese, `${key} has no Chinese in its Chinese string: ${pair[0]}`);
	}
	assert.ok(checked > 40, `only ${checked} keys were checked`);
});

test("dictionaries expose both languages under the keys the host expects", () => {
	const dict = dictionaries();
	assert.deepEqual(Object.keys(dict).sort(), ["en", "zh"]);
	assert.equal(Object.keys(dict.zh).length, keys().length);
	assert.equal(Object.keys(dict.en).length, keys().length);
	for (const key of keys()) {
		assert.equal(dict.zh[key], TABLE[key][0]);
		assert.equal(dict.en[key], TABLE[key][1]);
	}
});

test("the namespace is the settings-scoped one the panel registers", () => {
	assert.equal(NS, "settings.lumen");
	assert.ok(NS.startsWith("settings."), "the host scopes the panel's dictionary under settings.*");
});

test("translation picks the language and substitutes parameters", () => {
	const zh = createTranslator("zh-CN");
	const en = createTranslator("en-US");
	assert.equal(zh("status.on"), "已启用");
	assert.equal(en("status.on"), "on");
	assert.equal(zh("appearance.raised", { n: 62 }), "为保证文字可读，遮罩已自动加厚：壁纸可见约 62%");
	assert.equal(en("appearance.raised", { n: 62 }), "Thickened to keep text readable: about 62% of the wallpaper shows");
	assert.equal(zh("rotation.missed", { n: 3 }).indexOf("3") >= 0, true);
});

test("an unknown key returns itself rather than an empty string", () => {
	// The panel falls back to the key, so a missing string is visible in the UI
	// instead of rendering as a blank row nobody notices.
	const t = createTranslator("zh");
	assert.equal(t("no.such.key"), "no.such.key");
});

test("an unknown or absent language falls back to English, not to a crash", () => {
	for (const lang of [undefined, null, "", "de", "fr-FR", 42, {}]) {
		const t = createTranslator(lang);
		assert.equal(t("status.on"), "on");
	}
});

test("a repeated placeholder is substituted everywhere", () => {
	const t = createTranslator("en");
	const out = t("rotation.missed", { n: 2 });
	assert.equal(out.indexOf("{n}"), -1, "a placeholder survived");
});
