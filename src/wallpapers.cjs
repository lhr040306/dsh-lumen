"use strict";
/**
 * The built-in wallpaper library — five recipes, zero image assets.
 *
 * WHY GENERATED INSTEAD OF SHIPPED PICTURES
 *
 * The obvious way to ship "default wallpapers" is to bundle JPEGs. That has
 * three costs this project refuses to pay:
 *
 *   1. **Size.** A 2560x1440 photo is 300KB-1.5MB. Twelve of them is a
 *      double-digit-megabyte package, for assets a user will look at and
 *      probably replace.
 *   2. **Licensing.** Every bundled picture needs a licence, an attribution
 *      file, and a re-check on every release. Recipes need none.
 *   3. **Fixedness.** A JPEG is one picture. A recipe is a *family*: the same
 *      recipe at a different seed is a recognisably related but genuinely
 *      different background, which is what makes the "shake" button and the
 *      rotation scheduler worth having. You cannot rotate through one photo.
 *
 * A recipe is a pure function `(seed, hue, softness, grain) -> CSS`. Same
 * inputs, same picture, forever — which is what lets the tests pin the output
 * and lets the rotation scheduler restore exactly the wallpaper it showed
 * yesterday.
 *
 * COLOUR IS COMPUTED, NOT TYPED. Every stop comes out of OKLCH and is
 * gamut-mapped into sRGB by `oklab.cjs`, so "the light version of this recipe"
 * is a real perceptual relationship rather than a hand-tuned second palette.
 */

const { oklchToSrgb } = require("./oklab.cjs");
const { withAlpha } = require("./color.cjs");
const { createRng } = require("./rng.cjs");

const n = (value) => Math.round(value * 100) / 100;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** OKLCH -> `{r,g,b}` on the 0-255 display scale. */
function tone(L, chroma, hue) {
	const c = oklchToSrgb(clamp01(L), Math.max(0, chroma), hue);
	return { r: c.r * 255, g: c.g * 255, b: c.b * 255 };
}

/** An elliptical light blob: brightest at its centre, gone by `fade` percent. */
function radial({ x, y, rx, ry, color, alpha, fade }) {
	return `radial-gradient(${n(rx)}% ${n(ry)}% at ${n(x)}% ${n(y)}%, ${withAlpha(color, alpha)} 0%, ${withAlpha(color, 0)} ${n(fade)}%)`;
}

/** A corner-to-corner wash, used as the bottom-most layer of most recipes. */
function linear(angle, stops) {
	return `linear-gradient(${n(angle)}deg, ${stops.join(", ")})`;
}

/**
 * A darkening (or lightening) ring at the edges. Every dark recipe ends with
 * one: a wallpaper that is uniformly bright to the very corners gives the
 * washed UI no edge to sit against, and the result reads as "flat" rather
 * than "deep".
 */
function vignette(strength, inset) {
	return `radial-gradient(125% 105% at 50% 45%, rgba(0, 0, 0, 0) ${n(inset)}%, rgba(0, 0, 0, ${n(strength)}) 100%)`;
}

/** The mirror for light recipes: a soft white bloom at the edges. */
function halo(strength, inset) {
	return `radial-gradient(125% 105% at 50% 45%, rgba(255, 255, 255, 0) ${n(inset)}%, rgba(255, 255, 255, ${n(strength)}) 100%)`;
}

/**
 * The default knobs a recipe is designed around. The settings sliders move
 * *relative* to these, so a slider at its midpoint leaves every recipe looking
 * the way its author drew it — dragging it is a deliberate departure, not the
 * cost of admission.
 */
const NEUTRAL_TUNING = { hue: 0, softness: 0.5, grain: 0.35 };

/** Resolve the tuning record into the numbers a recipe's `build` consumes. */
function tune(tuning) {
	const t = tuning || {};
	return {
		hue: Number.isFinite(t.hue) ? t.hue : NEUTRAL_TUNING.hue,
		softness: Number.isFinite(t.softness) ? clamp01(t.softness) : NEUTRAL_TUNING.softness,
		grain: Number.isFinite(t.grain) ? clamp01(t.grain) : NEUTRAL_TUNING.grain
	};
}

const RECIPES = [
	{
		id: "drift",
		name: { zh: "弥散", en: "Drift" },
		scheme: "dark",
		tags: ["calm", "glow"],
		defaultSoftness: 0.62,
		defaultGrain: 0.22,
		complexity: 0.3,
		build(p, rng) {
			const h = 246 + p.hue;
			const soft = self(0.62, p.softness);
			const angle = rng.range(150, 230);
			const layers = [];
			const count = 4;
			for (let i = 0; i < count; i += 1) {
				const accent = i === count - 1 ? h + 96 : h + rng.range(-26, 26);
				layers.push(
					radial({
						x: rng.range(6, 94),
						y: rng.range(4, 84),
						rx: rng.range(34, 58) * (0.7 + soft * 0.7),
						ry: rng.range(30, 54) * (0.7 + soft * 0.7),
						color: tone(rng.range(0.44, 0.62), rng.range(0.09, 0.16), accent),
						alpha: rng.range(0.5, 0.82),
						fade: rng.range(78, 100)
					})
				);
			}
			layers.push(vignette(0.34 + soft * 0.16, 34));
			return { layers, base: tone(0.15, 0.028, h + 8) };
		}
	},
	{
		id: "aurora",
		name: { zh: "极光", en: "Aurora" },
		scheme: "dark",
		tags: ["cool", "band"],
		defaultSoftness: 0.72,
		defaultGrain: 0.18,
		complexity: 0.42,
		build(p, rng) {
			const h = 196 + p.hue;
			const soft = self(0.72, p.softness);
			const bands = 5;
			const layers = [];
			for (let i = 0; i < bands; i += 1) {
				const angle = rng.range(96, 126);
				const accent = h + i * rng.range(4, 13);
				layers.push(
					linear(angle, [
						`${withAlpha(tone(0.5, 0.12, accent), 0)} 0%`,
						`${withAlpha(tone(0.52, 0.14, accent + 12), rng.range(0.3, 0.56))} ${n(rng.range(28, 52))}%`,
						`${withAlpha(tone(0.4, 0.11, accent + 28), 0)} ${n(rng.range(74, 96))}%`
					])
				);
			}
			layers.push(
				radial({
					x: rng.range(20, 80),
					y: rng.range(8, 30),
					rx: 70 * (0.7 + soft * 0.8),
					ry: 40 * (0.7 + soft * 0.8),
					color: tone(0.62, 0.1, h + 22),
					alpha: 0.34,
					fade: 100
				})
			);
			layers.push(vignette(0.4 + soft * 0.12, 30));
			return { layers, base: tone(0.13, 0.036, h - 12) };
		}
	},
	{
		id: "starfield",
		name: { zh: "星野", en: "Starfield" },
		scheme: "dark",
		tags: ["night", "point"],
		defaultSoftness: 0.3,
		defaultGrain: 0.3,
		complexity: 0.55,
		build(p, rng) {
			const h = 252 + p.hue;
			const soft = self(0.3, p.softness);
			const stars = 42;
			const layers = [];
			for (let i = 0; i < stars; i += 1) {
				// A power curve, not a uniform draw: real star fields have a few
				// bright points and many faint ones, and a uniform draw reads as
				// evenly-spaced noise instead of a sky.
				const magnitude = Math.pow(rng.float(), 2.4);
				layers.push(
					radial({
						x: rng.range(0, 100),
						y: rng.range(0, 100),
						rx: rng.range(0.5, 1.9) * (0.6 + soft),
						ry: rng.range(0.5, 1.9) * (0.6 + soft),
						color: tone(0.86, 0.04, h + rng.range(-18, 18)),
						alpha: 0.12 + magnitude * 0.78,
						fade: 100
					})
				);
			}
			layers.push(
				radial({
					x: rng.range(30, 70),
					y: rng.range(55, 80),
					rx: 82 * (0.7 + soft * 0.6),
					ry: 46 * (0.7 + soft * 0.6),
					color: tone(0.42, 0.09, h + 34),
					alpha: 0.34,
					fade: 100
				})
			);
			layers.push(vignette(0.46 + soft * 0.14, 22));
			return { layers, base: tone(0.1, 0.03, h) };
		}
	},
	{
		id: "mist",
		name: { zh: "晨雾", en: "Mist" },
		scheme: "light",
		tags: ["cool", "calm"],
		defaultSoftness: 0.78,
		defaultGrain: 0.16,
		complexity: 0.2,
		build(p, rng) {
			const h = 232 + p.hue;
			const soft = self(0.78, p.softness);
			const layers = [
				linear(rng.range(150, 210), [
					`${withAlpha(tone(0.96, 0.016, h), 0.92)} 0%`,
					`${withAlpha(tone(0.87, 0.028, h + 6), 0.86)} 100%`
				])
			];
			for (let i = 0; i < 3; i += 1) {
				layers.push(
					radial({
						x: rng.range(-10, 110),
						y: rng.range(18, 92),
						rx: rng.range(48, 78) * (0.7 + soft * 0.8),
						ry: rng.range(22, 40) * (0.7 + soft * 0.8),
						color: tone(rng.range(0.88, 0.99), rng.range(0.01, 0.03), h + rng.range(-10, 16)),
						alpha: rng.range(0.42, 0.72),
						fade: 100
					})
				);
			}
			layers.push(halo(0.34 + soft * 0.16, 34));
			return { layers, base: tone(0.93, 0.018, h) };
		}
	},
	{
		id: "dune",
		name: { zh: "沙丘", en: "Dune" },
		scheme: "light",
		tags: ["warm", "band"],
		defaultSoftness: 0.5,
		defaultGrain: 0.34,
		complexity: 0.3,
		build(p, rng) {
			const h = 62 + p.hue;
			const soft = self(0.5, p.softness);
			const bands = 4;
			const layers = [];
			for (let i = 0; i < bands; i += 1) {
				const offset = rng.range(-6, 26);
				layers.push(
					linear(rng.range(155, 205), [
						`${withAlpha(tone(0.94 - i * 0.045, 0.03, h + offset), 0)} ${n(rng.range(0, 18))}%`,
						`${withAlpha(tone(0.93 - i * 0.05, 0.034, h + offset), rng.range(0.44, 0.72))} ${n(rng.range(38, 62))}%`,
						`${withAlpha(tone(0.86 - i * 0.05, 0.036, h + offset - 10), 0)} ${n(rng.range(78, 100))}%`
					])
				);
			}
			layers.push(
				radial({
					x: rng.range(24, 76),
					y: rng.range(10, 34),
					rx: 72 * (0.7 + soft * 0.7),
					ry: 46 * (0.7 + soft * 0.7),
					color: tone(0.99, 0.016, h + 16),
					alpha: 0.5,
					fade: 100
				})
			);
			layers.push(halo(0.3, 40));
			return { layers, base: tone(0.9, 0.036, h + 4) };
		}
	},
];

/**
 * Choose a recipe's own "design centre" when the user has left the slider at
 * its midpoint, and follow the user when they have not. Implemented as a lerp
 * rather than a switch so dragging the slider is a continuous departure from
 * the author's intent instead of a jump.
 */
function self(base, slider) {
	return clamp01(base + (slider - 0.5) * 0.8);
}

const RECIPE_IDS = RECIPES.map((r) => r.id);
const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

/** The recipe with this id, or `drift` when the id is unknown/absent. */
function getRecipe(id) {
	return RECIPE_BY_ID.get(id) || RECIPES[0];
}

/** True when `id` names a built-in recipe. */
function isRecipeId(id) {
	return RECIPE_BY_ID.has(id);
}

/**
 * Render a recipe into the two CSS values the backdrop layer needs.
 *
 * @param {{recipeId?: string, seed?: string|number, tuning?: object}} input
 * @returns {{backgroundImage: string, backgroundColor: string, scheme: string, complexity: number, recipeId: string, seed: string}}
 */
function renderRecipe(input) {
	const recipe = getRecipe(input && input.recipeId);
	const seed = input && input.seed !== undefined && input.seed !== null ? String(input.seed) : "default";
	const p = tune(input && input.tuning);
	const rng = createRng(`${recipe.id}:${seed}`);
	const built = recipe.build(p, rng);
	const base = built.base;
	return {
		backgroundImage: built.layers.join(", "),
		backgroundColor: `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`,
		scheme: recipe.scheme,
		complexity: recipe.complexity,
		recipeId: recipe.id,
		seed
	};
}

/** The default grain for a recipe (used to seed the grain slider per family). */
function defaultGrainFor(recipeId) {
	return getRecipe(recipeId).defaultGrain;
}

/** The default softness for a recipe. */
function defaultSoftnessFor(recipeId) {
	return getRecipe(recipeId).defaultSoftness;
}

module.exports = {
	RECIPES,
	RECIPE_IDS,
	NEUTRAL_TUNING,
	getRecipe,
	isRecipeId,
	renderRecipe,
	defaultGrainFor,
	defaultSoftnessFor
};
