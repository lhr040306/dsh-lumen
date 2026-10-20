"use strict";
/**
 * The built-in wallpapers.
 *
 * Two families live behind one id: generated recipes (`drift`, `mist`) and four
 * bundled illustrations. These run on Node with no DOM, which is the point of
 * the recipe layer being pure functions: a wallpaper can be checked, diffed and
 * regression-tested without a browser. What is asserted is reproducibility,
 * shape safety (the string is going into a CSS declaration), and that the
 * declared scheme matches how the picture actually measures.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	RECIPES,
	RECIPE_IDS,
	getRecipe,
	isRecipeId,
	isPhotoId,
	repairRecipeId,
	renderRecipe,
	defaultGrainFor,
	WALLPAPER_URL_PREFIX
} = require("../src/wallpapers.cjs");
const { isSafeBackgroundImage, DEFAULT_STATE, normalizeItem } = require("../src/state.cjs");
const { estimateImageLuminance, parseColor } = require("../src/color.cjs");

/** The generated half of the library — everything without a `photo` field. */
const GENERATED = RECIPES.filter((recipe) => typeof recipe.photo !== "string");
/** The bundled illustrations. */
const PHOTOS = RECIPES.filter((recipe) => typeof recipe.photo === "string");

test("the library ships six built-ins: two generated recipes and four illustrations", () => {
	assert.equal(RECIPES.length, 6);
	assert.equal(new Set(RECIPE_IDS).size, 6);
	assert.equal(GENERATED.length, 2);
	assert.equal(PHOTOS.length, 4);
	for (const recipe of RECIPES) {
		assert.ok(typeof recipe.id === "string" && /^[a-z]+(-[a-z]+)*$/.test(recipe.id), `odd id: ${recipe.id}`);
		assert.ok(recipe.name && recipe.name.zh && recipe.name.en, `${recipe.id} is missing a bilingual name`);
		assert.ok(recipe.scheme === "light" || recipe.scheme === "dark", `${recipe.id} has no scheme`);
		assert.equal(typeof recipe.build, "function");
	}
});

test("both colour schemes are represented", () => {
	// The generated family has to carry both, because that is the half a user
	// can re-colour: a family that is all one scheme is a family with one look.
	const light = GENERATED.filter((r) => r.scheme === "light").length;
	assert.ok(light >= 1 && light <= GENERATED.length - 1, `${light} light of ${GENERATED.length} generated is unbalanced`);
	// And the library as a whole must not be one scheme either.
	assert.ok(RECIPES.some((r) => r.scheme === "light") && RECIPES.some((r) => r.scheme === "dark"));
});

test("every built-in renders a value the engine will accept", () => {
	for (const recipe of RECIPES) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "audit" });
		assert.ok(
			isSafeBackgroundImage(out.backgroundImage),
			`${recipe.id} produced a value the safety gate would refuse: ${out.backgroundImage.slice(0, 80)}`
		);
		assert.notEqual(parseColor(out.backgroundColor), null, `${recipe.id} produced an unparsable base colour`);
		assert.equal(out.scheme, recipe.scheme);
		assert.equal(out.recipeId, recipe.id);
	}
});

test("a generated recipe renders a gradient stack, an illustration renders one url()", () => {
	for (const recipe of GENERATED) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "shape" });
		assert.ok(out.backgroundImage.length > 40, `${recipe.id} produced a suspiciously short value`);
		assert.ok(/-gradient\(/.test(out.backgroundImage), `${recipe.id} is not a gradient stack`);
		assert.equal(out.photo, false);
		assert.equal(out.luminance, null, `${recipe.id} claims a measured luminance it cannot have`);
	}
	for (const recipe of PHOTOS) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "shape" });
		assert.equal(out.backgroundImage, `url("${WALLPAPER_URL_PREFIX}/${recipe.photo}")`);
		assert.equal(out.photo, true);
		// The measurement is what lets the wash be solved against the real
		// picture instead of a constant, so a missing one is a regression.
		assert.equal(out.luminance, recipe.luminance);
		assert.ok(out.luminance > 0 && out.luminance < 1, `${recipe.id} luminance out of range`);
	}
});

test("an illustration's URL cannot be turned into another path", () => {
	// The shape gate is the only thing standing between a rendered value and an
	// arbitrary `url()` in a stylesheet, so prove it refuses the neighbours.
	assert.equal(isSafeBackgroundImage(`url("${WALLPAPER_URL_PREFIX}/whale-sunset.jpg")`), true);
	assert.equal(isSafeBackgroundImage(`url("${WALLPAPER_URL_PREFIX}/../../secret.jpg")`), false);
	assert.equal(isSafeBackgroundImage(`url("${WALLPAPER_URL_PREFIX}/whale sunset.jpg")`), false);
	assert.equal(isSafeBackgroundImage(`url("${WALLPAPER_URL_PREFIX}/whale-sunset.jpg?x=1")`), false);
	assert.equal(isSafeBackgroundImage('url("https://example.com/whale-sunset.jpg")'), true);
	assert.equal(isSafeBackgroundImage('url("file:///etc/passwd")'), false);
});

test("rendering is reproducible, and only the generated family answers a seed", () => {
	for (const recipe of RECIPES) {
		const a = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		const b = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		assert.equal(a.backgroundImage, b.backgroundImage, `${recipe.id} is not reproducible`);
	}
	for (const recipe of GENERATED) {
		const a = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		const c = renderRecipe({ recipeId: recipe.id, seed: "other" });
		assert.notEqual(a.backgroundImage, c.backgroundImage, `${recipe.id} ignores its seed`);
	}
	for (const recipe of PHOTOS) {
		// One picture is one picture: the seed selects a variation, and an
		// illustration has none to offer. This is asserted rather than ignored so
		// that "the shake button is hidden on a photo" has a reason behind it.
		const a = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		const c = renderRecipe({ recipeId: recipe.id, seed: "other" });
		assert.equal(a.backgroundImage, c.backgroundImage, `${recipe.id} pretends to vary with its seed`);
	}
});

test("a missing or unknown recipe falls back instead of throwing", () => {
	assert.equal(renderRecipe({}).recipeId, RECIPES[0].id);
	assert.equal(renderRecipe({ recipeId: "nope" }).recipeId, RECIPES[0].id);
	assert.equal(renderRecipe(null).recipeId, RECIPES[0].id);
	assert.equal(getRecipe("nope").id, RECIPES[0].id);
	assert.equal(isRecipeId("drift"), true);
	assert.equal(isRecipeId("nope"), false);
});

test("the retired recipes are mapped to survivors rather than collapsed onto the first", () => {
	// A document written before the library was trimmed can still name any of
	// these. Repairing all of them to `RECIPES[0]` would turn three deliberately
	// different wallpapers into three copies of one.
	for (const [retired, survivor] of [
		["aurora", "drift"],
		["starfield", "whale-starlit"],
		["dune", "mist"]
	]) {
		assert.equal(repairRecipeId(retired), survivor);
		assert.equal(isRecipeId(retired), false, `${retired} is still in the library`);
		const item = normalizeItem({ kind: "recipe", ref: retired, seed: "default" });
		assert.equal(item.ref, survivor);
	}
	// Nothing recognisable still lands on the first recipe, as it always has.
	assert.equal(repairRecipeId("totally-made-up"), null);
	assert.equal(normalizeItem({ kind: "recipe", ref: "totally-made-up" }).ref, RECIPES[0].id);
});

test("a fresh install opens on one of the illustrations", () => {
	assert.equal(DEFAULT_STATE.single.kind, "recipe");
	assert.equal(DEFAULT_STATE.single.ref, "whale-sunset");
	assert.equal(isPhotoId(DEFAULT_STATE.single.ref), true);
	// The default has to be renderable, or the first thing a new user sees after
	// installing is an empty canvas.
	const out = renderRecipe({ recipeId: DEFAULT_STATE.single.ref });
	assert.equal(isSafeBackgroundImage(out.backgroundImage), true);
});

test("colour scheme matches how the picture actually measures", () => {
	for (const recipe of GENERATED) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "measure" });
		const luminance = estimateImageLuminance(out.backgroundImage, parseColor(out.backgroundColor));
		if (recipe.scheme === "dark") {
			assert.ok(luminance < 0.3, `${recipe.id} claims dark but measures ${luminance.toFixed(3)}`);
		} else {
			assert.ok(luminance > 0.55, `${recipe.id} claims light but measures ${luminance.toFixed(3)}`);
		}
	}
	for (const recipe of PHOTOS) {
		// An illustration's brightness is measured on the file, not estimated
		// from its CSS — which is exactly why the library declares one.
		assert.ok(recipe.scheme === "dark" && recipe.luminance < 0.3, `${recipe.id} claims dark but measures ${recipe.luminance}`);
	}
});

test("the declared complexity stays inside its documented range", () => {
	for (const recipe of RECIPES) {
		assert.ok(recipe.complexity >= 0 && recipe.complexity <= 1, `${recipe.id} complexity out of range`);
	}
	// At least one deliberately quiet recipe and one deliberately busy one, or the
	// auto-dim feature has nothing to act on.
	assert.ok(RECIPES.some((r) => r.complexity <= 0.25), "no low-complexity recipe");
	assert.ok(RECIPES.some((r) => r.complexity > 0.45), "no high-complexity recipe");
});

test("the tuning knobs actually change the picture", () => {
	const base = renderRecipe({ recipeId: "drift", seed: "tune", tuning: { hue: 0, softness: 0.5, grain: 0.35 } });
	const hue = renderRecipe({ recipeId: "drift", seed: "tune", tuning: { hue: 60, softness: 0.5, grain: 0.35 } });
	const soft = renderRecipe({ recipeId: "drift", seed: "tune", tuning: { hue: 0, softness: 1, grain: 0.35 } });
	assert.notEqual(base.backgroundImage, hue.backgroundImage, "hue has no effect");
	assert.notEqual(base.backgroundImage, soft.backgroundImage, "softness has no effect");
});

test("out-of-range tuning is clamped rather than propagated", () => {
	const wild = renderRecipe({ recipeId: "mist", seed: "clamp", tuning: { hue: 100000, softness: -5, grain: 9 } });
	assert.ok(isSafeBackgroundImage(wild.backgroundImage));
	assert.ok(wild.backgroundImage.length > 40);
});

test("every recipe survives an extreme tuning sweep without emitting a broken value", () => {
	for (const recipe of RECIPES) {
		for (const hue of [-180, 0, 180]) {
			for (const softness of [0, 0.5, 1]) {
				const out = renderRecipe({ recipeId: recipe.id, seed: "sweep", tuning: { hue, softness, grain: 0.5 } });
				assert.ok(
					isSafeBackgroundImage(out.backgroundImage),
					`${recipe.id} broke at hue=${hue} softness=${softness}`
				);
			}
		}
	}
});

test("a recipe that claims neutrality keeps it under a hue shift", () => {
	// `paper` was the "no colour opinion" recipe: it scaled its own chroma down
	// as the hue offset grew, so the slider could not turn a neutral backdrop
	// into a coloured one. It has been retired, so the check is driven by the
	// `neutral` tag rather than by a list of ids — a list would go on naming
	// recipes that no longer exist (this test named `mono`, which never shipped
	// here) and would say nothing about the next one.
	for (const recipe of GENERATED.filter((entry) => entry.tags.includes("neutral"))) {
		const still = renderRecipe({ recipeId: recipe.id, seed: "neutral", tuning: { hue: 0, softness: 0.5, grain: 0.35 } });
		const shifted = renderRecipe({ recipeId: recipe.id, seed: "neutral", tuning: { hue: 180, softness: 0.5, grain: 0.35 } });
		const chroma = (out) => {
			const base = parseColor(out.backgroundColor);
			const max = Math.max(base.r, base.g, base.b);
			const min = Math.min(base.r, base.g, base.b);
			return max - min;
		};
		assert.ok(chroma(shifted) <= chroma(still) + 12, `${recipe.id} gained a colour cast at hue 180`);
	}
});

test("large stacks stay within a sane size", () => {
	for (const recipe of RECIPES) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "size" });
		assert.ok(out.backgroundImage.length < 16000, `${recipe.id} produced ${out.backgroundImage.length} characters`);
	}
});

test("defaultGrainFor reports a calibrated value for every recipe", () => {
	for (const id of RECIPE_IDS) {
		const grain = defaultGrainFor(id);
		assert.ok(grain >= 0 && grain <= 1, `${id} default grain out of range`);
	}
});

test("every illustration the library names is a file the package actually ships", () => {
	// The library and `media/wallpapers/` are two lists that cannot be allowed to
	// drift: a recipe naming a missing file is a built-in that renders nothing.
	const fs = require("node:fs");
	const path = require("node:path");
	const directory = path.join(__dirname, "..", "media", "wallpapers");
	for (const recipe of PHOTOS) {
		const file = path.join(directory, recipe.photo);
		assert.equal(fs.existsSync(file), true, `${recipe.id} names ${recipe.photo}, which is not in the package`);
		const bytes = fs.statSync(file).size;
		assert.ok(bytes > 1024, `${recipe.id} ships a file of ${bytes} bytes`);
	}
});
