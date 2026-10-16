"use strict";
/**
 * The state model: normalization, validation, and the two-tier store round-trip.
 *
 * The central claim being tested is that nothing reaches the renderer that the
 * renderer cannot consume — every field is clamped into its domain rather than
 * merely type-checked, and the safety predicates refuse by shape rather than
 * by denying a list of known attacks.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const state = require("../src/state.cjs");
const { RECIPE_IDS } = require("../src/wallpapers.cjs");

/** A tiny but valid data URL. */
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("defaultState is internally consistent and renderable", () => {
	const fresh = state.defaultState();
	const normalized = state.normalizeState(fresh);
	assert.equal(normalized.mode, "single");
	assert.equal(normalized.single.kind, "recipe");
	assert.ok(RECIPE_IDS.includes(normalized.single.ref));
	assert.equal(normalized.playlist.length, 0);
	assert.equal(normalized.paused, false);
	assert.equal(normalized.orderStep, 0);
	assert.ok(normalized.wash.opacity >= state.OPACITY_MIN && normalized.wash.opacity <= state.OPACITY_MAX);
});

test("normalizeState repairs a hostile or stale document", () => {
	const repaired = state.normalizeState({
		mode: "rotation",
		cursor: 999,
		orderStep: -4,
		nextAt: -1,
		wash: { opacity: 4.2, blur: 9999, fit: "nope", autoDim: "yes" },
		tuning: { hue: -1e6, softness: 8, grain: Number.NaN },
		schedule: { mode: "hourly", intervalMin: -3 },
		playlist: [
			{ kind: "recipe", ref: "not-a-recipe" },
			{ kind: "bogus", ref: "x" },
			{ kind: "gradient", ref: "linear-gradient(90deg, #000 0%, #fff 100%)" },
			null
		]
	});
	assert.equal(repaired.cursor, 1, "cursor clamped to the repaired playlist");
	assert.equal(repaired.orderStep, 0);
	assert.equal(repaired.nextAt, 0);
	assert.equal(repaired.wash.opacity, state.OPACITY_MAX);
	assert.equal(repaired.wash.blur, state.BLUR_MAX);
	assert.equal(repaired.wash.fit, "cover");
	assert.equal(repaired.wash.autoDim, true, "an absent flag stays on");
	assert.equal(repaired.tuning.hue, -180);
	assert.equal(repaired.tuning.softness, 1);
	assert.equal(repaired.tuning.grain, state.normalizeTuning({}).grain, "NaN falls back to the default");
	// The unknown recipe is substituted (not dropped) and the invalid kind dropped.
	assert.equal(repaired.playlist.length, 2);
	assert.ok(RECIPE_IDS.includes(repaired.playlist[0].ref));
	assert.equal(repaired.playlist[1].kind, "gradient");
});

test("normalizeState never throws, whatever it is handed", () => {
	for (const input of [null, undefined, 0, "", [], "text", { playlist: "no" }, { single: 42 }, { wash: [] }]) {
		const out = state.normalizeState(input);
		assert.equal(typeof out, "object");
		assert.ok(out.wash && out.tuning && out.schedule && out.single);
		assert.ok(Array.isArray(out.playlist));
	}
});

test("rotation mode reverts to single when there is nothing to rotate", () => {
	const out = state.normalizeState({ mode: "rotation", playlist: [] });
	assert.equal(out.mode, "single", "an empty playlist must not arm a rotation");
});

test("the playlist is capped", () => {
	const many = Array.from({ length: 60 }, () => ({ kind: "recipe", ref: "drift" }));
	const out = state.normalizeState({ playlist: many });
	assert.equal(out.playlist.length, state.MAX_PLAYLIST);
});

test("currentItem follows the mode", () => {
	const single = state.normalizeState({ mode: "single", single: { kind: "recipe", ref: "mist" } });
	assert.equal(state.currentItem(single).ref, "mist");
	const rotating = state.normalizeState({
		mode: "rotation",
		cursor: 1,
		playlist: [{ kind: "recipe", ref: "drift" }, { kind: "recipe", ref: "ember" }]
	});
	assert.equal(state.currentItem(rotating).ref, "ember");
	// A rotation that lost its playlist mid-flight still shows something.
	const orphaned = state.normalizeState({ mode: "rotation", playlist: [], single: { kind: "recipe", ref: "ivory" } });
	assert.equal(state.currentItem(orphaned).ref, "ivory");
});

test("gradient validation is an allow-list, not a deny-list", () => {
	assert.equal(state.isSafeGradient("linear-gradient(90deg, #000 0%, #fff 100%)"), true);
	assert.equal(state.isSafeGradient("radial-gradient(50% 50% at 50% 50%, rgba(1, 2, 3, 0.5) 0%, rgba(1, 2, 3, 0) 100%)"), true);
	assert.equal(state.isSafeGradient("conic-gradient(from 90deg, #fff, #000)"), true);

	// Declaration escape, url() smuggling, comment trick, tag injection.
	assert.equal(state.isSafeGradient("linear-gradient(#fff 0%, #000 100%); color: red"), false);
	assert.equal(state.isSafeGradient("linear-gradient(url(javascript:alert(1)) 0%, #000 100%)"), false);
	assert.equal(state.isSafeGradient("linear-gradient(/*x*/#fff 0%, #000 100%)"), false);
	assert.equal(state.isSafeGradient("linear-gradient(<script> 0%, #000 100%)"), false);
	assert.equal(state.isSafeGradient("linear-gradient(#fff 0%, #000 100%"), false, "unbalanced paren swallowed the rest");
	assert.equal(state.isSafeGradient("solid"), false, "not a gradient function");
	assert.equal(state.isSafeGradient(""), false);
	assert.equal(state.isSafeGradient(null), false);
	assert.equal(state.isSafeGradient(`linear-gradient(${"#fff 0%, ".repeat(200)}#000 100%)`), false, "over the length cap");
});

test("URL validation accepts http(s) only and refuses CSS-breaking characters", () => {
	assert.equal(state.isSafeWallpaperUrl("https://example.com/a.jpg"), true);
	assert.equal(state.isSafeWallpaperUrl("http://127.0.0.1:8080/a.png?x=1#y"), true);
	assert.equal(state.isSafeWallpaperUrl("file:///etc/passwd"), false);
	assert.equal(state.isSafeWallpaperUrl("javascript:alert(1)"), false);
	assert.equal(state.isSafeWallpaperUrl("data:image/png;base64,AAA"), false);
	assert.equal(state.isSafeWallpaperUrl('https://example.com/a.jpg" ) ; } body{display:none} .x{a:"'), false);
	assert.equal(state.isSafeWallpaperUrl(" https://example.com/a b.jpg"), false, "whitespace breaks the wrapper");
	assert.equal(state.isSafeWallpaperUrl(""), false);
});

test("data-URL validation accepts only base64 image payloads", () => {
	assert.equal(state.isSafeDataImage(TINY_PNG), true);
	assert.equal(state.isSafeDataImage("data:image/jpeg;base64,AAAA"), true);
	assert.equal(state.isSafeDataImage("data:text/html;base64,AAAA"), false);
	assert.equal(state.isSafeDataImage("data:image/png,notbase64"), false);
	assert.equal(state.isSafeDataImage(`data:image/png;base64,${"A".repeat(state.MAX_IMAGE_CHARS)}`), false, "over the size cap");
	assert.equal(state.isSafeDataImage(""), false);
});

test("composed background values are validated by shape", () => {
	assert.equal(state.isSafeBackgroundImage("linear-gradient(90deg, #000 0%, #fff 100%)"), true);
	assert.equal(state.isSafeBackgroundImage("radial-gradient(10% 10% at 1% 1%, rgba(1,2,3,0.5) 0%, rgba(1,2,3,0) 100%), linear-gradient(90deg, #000 0%, #fff 100%)"), true, "a multi-layer stack");
	assert.equal(state.isSafeBackgroundImage(`url("${TINY_PNG}")`), true);
	assert.equal(state.isSafeBackgroundImage('url("https://example.com/a.jpg")'), true);
	assert.equal(state.isSafeBackgroundImage('url("javascript:alert(1)")'), false);
	assert.equal(state.isSafeBackgroundImage('url("https://example.com/a.jpg") , linear-gradient(#fff 0%, #000 100%)'), false, "a url mixed into a stack is not a shape we emit");
	assert.equal(state.isSafeBackgroundImage("linear-gradient(#fff 0%, #000 100%); background: red"), false);
	assert.equal(state.isSafeBackgroundImage(""), false);
	assert.equal(state.isSafeBackgroundImage(null), false);
});

test("describeItem produces a short readable label", () => {
	assert.equal(state.describeItem({ kind: "recipe", ref: "drift", seed: "default" }), "drift");
	assert.equal(state.describeItem({ kind: "url", ref: "https://cdn.example.com/a.jpg", seed: "default" }), "cdn.example.com");
	assert.ok(state.describeItem({ kind: "image", ref: TINY_PNG, seed: "default" }).indexOf("image") === 0);
	assert.equal(state.describeItem({ kind: "gradient", ref: "linear-gradient(#000 0%, #fff 100%)", seed: "default" }), "gradient");
	assert.equal(state.describeItem(null), "");
});

test("every preference gets its own key, and image payloads get theirs", () => {
	const withImage = state.normalizeState({
		playlist: [
			{ id: "a1", kind: "recipe", ref: "drift", seed: "default" },
			{ id: "b2", kind: "image", ref: TINY_PNG, seed: "default" }
		]
	});
	const map = state.toStore(withImage);
	// One key per preference is what lets the host's merge keep two writers from
	// overwriting each other's unrelated fields.
	for (const key of state.DOC_KEYS) {
		assert.ok(Object.prototype.hasOwnProperty.call(map, key), `the ${key} field has no key of its own`);
	}
	assert.equal(map.schema, String(state.SCHEMA), "the document is stamped with its schema");
	assert.equal(map["blob:b2"], TINY_PNG, "the payload became its own key");
	// The preferences must stay small even though an image is in the playlist.
	const prefs = state.DOC_KEYS.map((key) => map[key]).join("");
	assert.ok(prefs.length < 1200, `the preference keys total ${prefs.length} characters`);
	assert.equal(prefs.indexOf("iVBORw0KGgo"), -1, "the payload leaked into a preference key");
});

test("DOC_KEYS covers exactly the fields a state carries", () => {
	// A field added to the state but not to DOC_KEYS would silently stop being
	// persisted, which is invisible until someone notices a setting that resets.
	const fields = Object.keys(state.defaultState()).sort();
	assert.deepEqual([...state.DOC_KEYS].sort(), fields);
});

test("a store round-trip preserves the playlist and rehydrates payloads", () => {
	const original = state.normalizeState({
		mode: "rotation",
		cursor: 1,
		playlist: [
			{ id: "a1", kind: "recipe", ref: "ember", seed: "s1" },
			{ id: "b2", kind: "image", ref: TINY_PNG, seed: "default" },
			{ id: "c3", kind: "gradient", ref: "linear-gradient(90deg, #000 0%, #fff 100%)", seed: "default" }
		],
		wash: { opacity: 0.5, blur: 12 }
	});
	const restored = state.fromStore(state.toStore(original));
	assert.equal(restored.mode, "rotation");
	assert.equal(restored.cursor, 1);
	assert.equal(restored.playlist.length, 3);
	assert.equal(restored.playlist[0].ref, "ember");
	assert.equal(restored.playlist[0].seed, "s1");
	assert.equal(restored.playlist[1].ref, TINY_PNG, "the payload did not come back");
	assert.equal(restored.playlist[2].ref, "linear-gradient(90deg, #000 0%, #fff 100%)");
	assert.equal(restored.wash.opacity, 0.5);
	assert.equal(restored.wash.blur, 12);
});

test("a missing payload drops that entry instead of producing a broken one", () => {
	const map = state.toStore(state.normalizeState({
		playlist: [
			{ id: "a1", kind: "recipe", ref: "drift", seed: "default" },
			{ id: "b2", kind: "image", ref: TINY_PNG, seed: "default" }
		]
	}));
	delete map["blob:b2"];
	const restored = state.fromStore(map);
	assert.equal(restored.playlist.length, 1);
	assert.equal(restored.playlist[0].kind, "recipe");
});

test("fromStore degrades to defaults on a corrupt or absent document", () => {
	for (const input of [null, {}, { state: "not json" }, { state: "[]" }, { state: '{"playlist":5}' }]) {
		const out = state.fromStore(input);
		assert.equal(out.mode, "single");
		assert.ok(Array.isArray(out.playlist));
	}
});

test("a partial map falls back to defaults per field", () => {
	// The host merges patches, so a field the user never touched is genuinely
	// absent. Falling back per field is what lets an improved default reach
	// users who never overrode it.
	const out = state.fromStore({ mode: '"rotation"', wash: JSON.stringify({ opacity: 0.5 }) });
	assert.equal(out.wash.opacity, 0.5, "the stored field was lost");
	assert.equal(out.wash.blur, state.DEFAULT_STATE.wash.blur, "an absent field did not default");
	assert.equal(out.playlist.length, 0);
	assert.equal(out.single.kind, state.DEFAULT_STATE.single.kind);
});

test("a corrupt field does not take its neighbours down with it", () => {
	const out = state.fromStore({
		wash: "{ not json",
		tuning: JSON.stringify({ hue: 45, softness: 0.2, grain: 0.1 }),
		single: "also broken"
	});
	assert.equal(out.wash.opacity, state.DEFAULT_STATE.wash.opacity, "the corrupt field did not default");
	assert.equal(out.tuning.hue, 45, "a healthy neighbour was lost");
	assert.equal(out.single.kind, state.DEFAULT_STATE.single.kind);
});

test("the single-document layout written by an earlier build is still readable", () => {
	// Without this fallback, upgrading would read an empty map and reset every
	// preference — the kind of bug that looks like "the plugin forgot my setup".
	const legacy = {
		state: JSON.stringify({
			schema: 1,
			mode: "rotation",
			cursor: 1,
			playlist: [{ id: "a1", kind: "recipe", ref: "ember", seed: "s1" }],
			wash: { opacity: 0.6, blur: 3 },
			tuning: { hue: 20 }
		})
	};
	const out = state.fromStore(legacy);
	assert.equal(out.mode, "rotation");
	// A one-entry playlist clamps the stored cursor back to 0.
	assert.equal(out.cursor, 0);
	assert.equal(out.playlist.length, 1);
	assert.equal(out.playlist[0].ref, "ember");
	assert.equal(out.wash.opacity, 0.6);
	assert.equal(out.tuning.hue, 20);
});

test("a per-field value wins over the legacy document", () => {
	// Mid-migration the file can hold both; the newer layout must be preferred.
	const out = state.fromStore({
		state: JSON.stringify({ wash: { opacity: 0.3 } }),
		wash: JSON.stringify({ opacity: 0.9 })
	});
	assert.equal(out.wash.opacity, 0.9);
});

test("blobKeysOf lists every payload the state owns", () => {
	const withImage = state.normalizeState({
		single: { id: "s1", kind: "image", ref: TINY_PNG, seed: "default" },
		playlist: [{ id: "b2", kind: "image", ref: TINY_PNG, seed: "default" }]
	});
	const keys = state.blobKeysOf(withImage);
	assert.deepEqual(keys.sort(), ["blob:b2", "blob:s1"]);
});

test("a user-supplied seed is truncated, not trusted", () => {
	assert.equal(state.normalizeSeed("  ab  "), "ab");
	assert.equal(state.normalizeSeed(""), "default");
	assert.equal(state.normalizeSeed(null), "default");
	assert.equal(state.normalizeSeed(42), "42");
	assert.equal(state.normalizeSeed("x".repeat(500)).length, 64);
});

test("createItem refuses what normalizeItem refuses", () => {
	const item = state.createItem("recipe", "drift");
	assert.equal(item.kind, "recipe");
	assert.equal(item.ref, "drift");
	assert.notEqual(item.id, undefined);
	// Two items never share an id, even when minted in the same millisecond.
	assert.notEqual(state.createItem("recipe", "mist").id, item.id);
	assert.equal(state.createItem("bogus", "drift"), null);
	assert.equal(state.createItem("url", "javascript:alert(1)"), null);
	assert.equal(state.createItem("gradient", "solid"), null);
	const image = state.createItem("image", TINY_PNG);
	assert.equal(image.kind, "image");
	assert.ok(typeof image.id === "string" && image.id.length > 0);
});

test("wash flags default on and only an explicit false turns them off", () => {
	assert.equal(state.normalizeWash({}).autoDim, true);
	assert.equal(state.normalizeWash({ autoDim: false }).autoDim, false);
	assert.equal(state.normalizeWash({ autoDim: 0 }).autoDim, true);
	assert.equal(state.normalizeWash({ readability: false }).readability, false);
});

test("the nine wash positions are distinct and all are CSS-legal", () => {
	// The grid in the panel is built from this list, and the value goes straight
	// into `background-position` — so a duplicate or a stray word would either
	// render two identical cells or produce a declaration the engine drops.
	assert.equal(state.WASH_POSITIONS.length, 9);
	assert.equal(new Set(state.WASH_POSITIONS).size, 9, "two positions share a value");
	assert.equal(state.WASH_POSITIONS[0], "center", "the default must be the first entry");
	for (const value of state.WASH_POSITIONS) {
		assert.match(value, /^(center|top|bottom|left|right)( (top|bottom|left|right))?$/, `"${value}" is not a legal background-position`);
	}
	// A corner is only ever written as `<vertical> <horizontal>`, never the
	// reverse, or `background-position` would silently swap the axes.
	assert.ok(!state.WASH_POSITIONS.includes("left top"));
});

test("wash.position survives normalization and a bad value is repaired", () => {
	assert.equal(state.normalizeWash({}).position, "center", "an absent position must default");
	assert.equal(state.normalizeWash({ position: "bottom right" }).position, "bottom right");
	for (const bad of ["middle", "50% 50%", "bottom middle", "", null, 7, {}]) {
		assert.equal(state.normalizeWash({ position: bad }).position, "center", `"${bad}" was not repaired`);
	}
	// Round-tripped through the whole document, not just the sub-record.
	assert.equal(state.normalizeState({ wash: { position: "top left" } }).wash.position, "top left");
	assert.equal(state.normalizeState({ wash: { position: "top left corner" } }).wash.position, "center");
});

test("a measured luminance is kept exact, and anything else becomes null", () => {
	// `null` means "no measurement" and is read by the engine as "fall back".
	// The failure mode being guarded is a lenient conversion: `Number(null)` is
	// 0, `Number("")` is 0, and 0 is pure black — the one luminance at which the
	// readability floor stops protecting anything. So every non-number must
	// become `null`, never 0.
	for (const value of [null, undefined, "0.5", "", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01, {}, [], true]) {
		assert.equal(state.normalizeLuminance(value), null, `${JSON.stringify(value)} was accepted`);
	}
	assert.equal(state.normalizeLuminance(0), 0, "a genuine black measurement is legal");
	assert.equal(state.normalizeLuminance(1), 1);
	assert.equal(state.normalizeLuminance(0.2158605001138992), 0.216, "the measurement is not rounded for storage");
	// Idempotent: re-normalizing a stored value does not drift it.
	assert.equal(state.normalizeLuminance(state.normalizeLuminance(0.12345)), 0.123);
});

test("an item carries its luminance through the whole store round-trip", () => {
	// The measurement is what lets the readability floor stop guessing on a
	// local photo. If it is dropped by `stripPayload` the floor silently
	// reverts to the neutral constant for exactly the pictures it could have
	// measured — a regression with no visible symptom except worse contrast.
	const original = state.normalizeState({
		mode: "rotation",
		single: { id: "s0", kind: "image", ref: TINY_PNG, seed: "default", luminance: 0.84 },
		playlist: [
			{ id: "a1", kind: "image", ref: TINY_PNG, seed: "s1", luminance: 0.03 },
			{ id: "b2", kind: "recipe", ref: "drift", seed: "default" }
		]
	});
	assert.equal(original.single.luminance, 0.84, "normalizeItem dropped the measurement");
	assert.equal(original.playlist[0].luminance, 0.03);

	const map = state.toStore(original);
	// The blob payload is stripped, but the measurement must survive beside it.
	const doc = JSON.parse(map.single);
	assert.equal(doc.ref, null, "the payload was not stripped from the document");
	assert.equal(doc.luminance, 0.84, "stripPayload dropped the measurement");

	const restored = state.fromStore(map);
	assert.equal(restored.single.ref, TINY_PNG, "the payload did not come back");
	assert.equal(restored.single.luminance, 0.84, "the measurement did not come back");
	assert.equal(restored.playlist[0].luminance, 0.03);
	assert.equal(restored.playlist[1].luminance, null, "an unmeasured entry must stay unmeasured");
});

test("createItem carries a luminance argument and rejects a nonsense one", () => {
	const measured = state.createItem("image", TINY_PNG, "default", 0.77);
	assert.equal(measured.luminance, 0.77);
	assert.equal(state.createItem("image", TINY_PNG).luminance, null, "an omitted measurement must stay null");
	assert.equal(state.createItem("image", TINY_PNG, "default", "bright").luminance, null);
});
