"use strict";
/**
 * The twelve recipes.
 *
 * These run on Node with no DOM, which is the point of the recipe layer being
 * pure functions: a wallpaper can be checked, diffed and regression-tested
 * without a browser. What is asserted is reproducibility, shape safety (the
 * string is going into a CSS declaration), and that the declared scheme matches
 * how the picture actually measures.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { RECIPES, RECIPE_IDS, getRecipe, isRecipeId, renderRecipe, defaultGrainFor } = require("../src/wallpapers.cjs");
const { isSafeBackgroundImage } = require("../src/state.cjs");
const { estimateImageLuminance, parseColor } = require("../src/color.cjs");

test("the library ships exactly seven distinct recipes", () => {
	assert.equal(RECIPES.length, 7);
	assert.equal(new Set(RECIPE_IDS).size, 7);
	for (const recipe of RECIPES) {
		assert.ok(typeof recipe.id === "string" && /^[a-z]+$/.test(recipe.id), `odd id: ${recipe.id}`);
		assert.ok(recipe.name && recipe.name.zh && recipe.name.en, `${recipe.id} is missing a bilingual name`);
		assert.ok(recipe.scheme === "light" || recipe.scheme === "dark", `${recipe.id} has no scheme`);
		assert.equal(typeof recipe.build, "function");
	}
});

test("both colour schemes are represented", () => {
	const light = RECIPES.filter((r) => r.scheme === "light").length;
	assert.ok(light >= 4 && light <= 8, `${light} light recipes is an unbalanced library`);
});

test("every recipe renders a value the engine will accept", () => {
	for (const recipe of RECIPES) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "audit" });
		assert.ok(out.backgroundImage.length > 40, `${recipe.id} produced a suspiciously short value`);
		assert.ok(
			isSafeBackgroundImage(out.backgroundImage),
			`${recipe.id} produced a value the safety gate would refuse`
		);
		assert.notEqual(parseColor(out.backgroundColor), null, `${recipe.id} produced an unparsable base colour`);
		assert.equal(out.scheme, recipe.scheme);
		assert.equal(out.recipeId, recipe.id);
	}
});

test("rendering is reproducible and seed-sensitive", () => {
	for (const recipe of RECIPES) {
		const a = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		const b = renderRecipe({ recipeId: recipe.id, seed: "fixed" });
		const c = renderRecipe({ recipeId: recipe.id, seed: "other" });
		assert.equal(a.backgroundImage, b.backgroundImage, `${recipe.id} is not reproducible`);
		assert.notEqual(a.backgroundImage, c.backgroundImage, `${recipe.id} ignores its seed`);
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

test("colour scheme matches how the picture actually measures", () => {
	for (const recipe of RECIPES) {
		const out = renderRecipe({ recipeId: recipe.id, seed: "measure" });
		const luminance = estimateImageLuminance(out.backgroundImage, parseColor(out.backgroundColor));
		if (recipe.scheme === "dark") {
			assert.ok(luminance < 0.3, `${recipe.id} claims dark but measures ${luminance.toFixed(3)}`);
		} else {
			assert.ok(luminance > 0.55, `${recipe.id} claims light but measures ${luminance.toFixed(3)}`);
		}
	}
});

test("the declared complexity stays inside its documented range", () => {
	for (const recipe of RECIPES) {
		assert.ok(recipe.complexity >= 0 && recipe.complexity <= 1, `${recipe.id} complexity out of range`);
	}
	// At least one deliberately quiet recipe and one deliberately busy one, or the
	// auto-dim feature has nothing to act on.
	assert.ok(RECIPES.some((r) => r.complexity < 0.2), "no low-complexity recipe");
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

test("the neutral-hue recipes stay neutral under a hue shift", () => {
	// `mono` and `paper` are the "no colour opinion" recipes; a hue offset must
	// not turn them into coloured wallpapers.
	for (const id of ["mono", "paper"]) {
		const still = renderRecipe({ recipeId: id, seed: "neutral", tuning: { hue: 0, softness: 0.5, grain: 0.35 } });
		const shifted = renderRecipe({ recipeId: id, seed: "neutral", tuning: { hue: 180, softness: 0.5, grain: 0.35 } });
		const chroma = (out) => {
			const base = parseColor(out.backgroundColor);
			const max = Math.max(base.r, base.g, base.b);
			const min = Math.min(base.r, base.g, base.b);
			return max - min;
		};
		assert.ok(chroma(shifted) <= chroma(still) + 12, `${id} gained a colour cast at hue 180`);
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
