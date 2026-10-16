"use strict";
/**
 * The built-in wallpaper library — twelve recipes, zero image assets.
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
		id: "abyss",
		name: { zh: "深海", en: "Abyss" },
		scheme: "dark",
		tags: ["deep", "cool"],
		defaultSoftness: 0.66,
		defaultGrain: 0.16,
		complexity: 0.34,
		build(p, rng) {
			const h = 194 + p.hue;
			const soft = self(0.66, p.softness);
			const layers = [
				linear(rng.range(12, 32), [
					`${withAlpha(tone(0.1, 0.03, h + 10), 0)} 0%`,
					`${withAlpha(tone(0.26, 0.07, h), 0.72)} ${n(rng.range(66, 84))}%`,
					`${withAlpha(tone(0.34, 0.08, h - 14), 0.9)} 100%`
				]),
				radial({
					x: rng.range(28, 72),
					y: rng.range(74, 92),
					rx: 74 * (0.7 + soft * 0.7),
					ry: 40 * (0.7 + soft * 0.7),
					color: tone(0.5, 0.1, h - 8),
					alpha: 0.3,
					fade: 100
				}),
				vignette(0.52 + soft * 0.12, 18)
			];
			return { layers, base: tone(0.09, 0.024, h + 6) };
		}
	},
	{
		id: "ember",
		name: { zh: "暮霭", en: "Ember" },
		scheme: "dark",
		tags: ["warm", "dusk"],
		defaultSoftness: 0.7,
		defaultGrain: 0.26,
		complexity: 0.44,
		build(p, rng) {
			const h = 34 + p.hue;
			const soft = self(0.7, p.softness);
			const layers = [
				linear(rng.range(200, 240), [
					`${withAlpha(tone(0.58, 0.11, h + 12), 0.72)} 0%`,
					`${withAlpha(tone(0.4, 0.09, h - 10), 0.5)} ${n(rng.range(40, 58))}%`,
					`${withAlpha(tone(0.24, 0.07, h - 92), 0.6)} 100%`
				]),
				radial({
					x: rng.range(18, 46),
					y: rng.range(22, 46),
					rx: 66 * (0.7 + soft * 0.7),
					ry: 48 * (0.7 + soft * 0.7),
					color: tone(0.68, 0.1, h + 8),
					alpha: 0.42,
					fade: 100
				}),
				radial({
					x: rng.range(58, 88),
					y: rng.range(58, 86),
					rx: 60 * (0.7 + soft * 0.7),
					ry: 44 * (0.7 + soft * 0.7),
					color: tone(0.4, 0.09, h - 110),
					alpha: 0.36,
					fade: 100
				}),
				vignette(0.36 + soft * 0.14, 34)
			];
			return { layers, base: tone(0.19, 0.045, h - 34) };
		}
	},
	{
		id: "mono",
		name: { zh: "墨韵", en: "Mono" },
		scheme: "dark",
		tags: ["minimal", "neutral"],
		defaultSoftness: 0.58,
		defaultGrain: 0.2,
		complexity: 0.18,
		build(p, rng) {
			// Chroma deliberately near zero: this is the "no colour opinion"
			// recipe, and it must stay neutral whatever the hue slider says.
			const chromaScale = 1 - Math.min(1, Math.abs(p.hue) / 90);
			const h = 250 + p.hue;
			const soft = self(0.58, p.softness);
			const layers = [
				linear(rng.range(140, 200), [
					`${withAlpha(tone(0.24, 0.012 * chromaScale, h), 0.8)} 0%`,
					`${withAlpha(tone(0.13, 0.01 * chromaScale, h), 0.9)} 100%`
				]),
				radial({
					x: rng.range(26, 74),
					y: rng.range(16, 44),
					rx: 70 * (0.7 + soft * 0.8),
					ry: 52 * (0.7 + soft * 0.8),
					color: tone(0.46, 0.012 * chromaScale, h),
					alpha: 0.3,
					fade: 100
				}),
				vignette(0.34, 38)
			];
			return { layers, base: tone(0.12, 0.01, h) };
		}
	},
	{
		id: "lumen",
		name: { zh: "光晕", en: "Halo" },
		scheme: "dark",
		tags: ["focus", "glow"],
		defaultSoftness: 0.6,
		defaultGrain: 0.18,
		complexity: 0.36,
		build(p, rng) {
			const h = 222 + p.hue;
			const soft = self(0.6, p.softness);
			const layers = [
				radial({
					x: rng.range(34, 66),
					y: rng.range(14, 34),
					rx: (42 + soft * 30) * rng.range(0.88, 1.12),
					ry: (30 + soft * 22) * rng.range(0.88, 1.12),
					color: tone(0.72, 0.09, h + 6),
					alpha: 0.66,
					fade: 100
				}),
				radial({
					x: rng.range(28, 72),
					y: rng.range(46, 76),
					rx: 80 * (0.7 + soft * 0.7),
					ry: 44 * (0.7 + soft * 0.7),
					color: tone(0.4, 0.08, h - 30),
					alpha: 0.3,
					fade: 100
				}),
				vignette(0.5 + soft * 0.12, 20)
			];
			return { layers, base: tone(0.11, 0.026, h) };
		}
	},
	{
		id: "ivory",
		name: { zh: "象牙", en: "Ivory" },
		scheme: "light",
		tags: ["warm", "paper"],
		defaultSoftness: 0.64,
		defaultGrain: 0.3,
		complexity: 0.22,
		build(p, rng) {
			const h = 76 + p.hue;
			const soft = self(0.64, p.softness);
			const layers = [
				linear(rng.range(120, 190), [
					`${withAlpha(tone(0.94, 0.022, h), 0.9)} 0%`,
					`${withAlpha(tone(0.88, 0.03, h - 14), 0.85)} 100%`
				]),
				radial({
					x: rng.range(18, 44),
					y: rng.range(14, 40),
					rx: 66 * (0.7 + soft * 0.8),
					ry: 50 * (0.7 + soft * 0.8),
					color: tone(0.99, 0.014, h + 6),
					alpha: 0.66,
					fade: 100
				}),
				radial({
					x: rng.range(56, 88),
					y: rng.range(58, 88),
					rx: 58 * (0.7 + soft * 0.8),
					ry: 44 * (0.7 + soft * 0.8),
					color: tone(0.83, 0.035, h - 26),
					alpha: 0.4,
					fade: 100
				}),
				halo(0.3 + soft * 0.2, 40)
			];
			return { layers, base: tone(0.93, 0.024, h - 8) };
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
	{
		id: "glacier",
		name: { zh: "冰川", en: "Glacier" },
		scheme: "light",
		tags: ["cool", "facet"],
		defaultSoftness: 0.44,
		defaultGrain: 0.22,
		complexity: 0.34,
		build(p, rng) {
			const h = 204 + p.hue;
			const soft = self(0.44, p.softness);
			const layers = [];
			for (let i = 0; i < 3; i += 1) {
				// Tight angular wedges: the "facet" character that separates this
				// recipe from `mist`'s wide soft veils.
				const angle = rng.range(96, 264);
				layers.push(
					linear(angle, [
						`${withAlpha(tone(0.9 - i * 0.04, 0.03, h + i * 16), 0)} 0%`,
						`${withAlpha(tone(0.93 - i * 0.035, 0.032, h + i * 16), rng.range(0.4, 0.66))} ${n(rng.range(30, 58))}%`,
						`${withAlpha(tone(0.85 - i * 0.03, 0.034, h + i * 16 - 8), 0)} ${n(rng.range(70, 98))}%`
					])
				);
			}
			layers.push(
				radial({
					x: rng.range(30, 70),
					y: rng.range(8, 30),
					rx: 66 * (0.7 + soft * 0.7),
					ry: 40 * (0.7 + soft * 0.7),
					color: tone(0.99, 0.012, h + 20),
					alpha: 0.56,
					fade: 100
				})
			);
			layers.push(halo(0.32, 38));
			return { layers, base: tone(0.92, 0.026, h + 2) };
		}
	},
	{
		id: "paper",
		name: { zh: "纸纹", en: "Paper" },
		scheme: "light",
		tags: ["paper", "neutral"],
		defaultSoftness: 0.5,
		defaultGrain: 0.62,
		complexity: 0.14,
		build(p, rng) {
			const chromaScale = 1 - Math.min(1, Math.abs(p.hue) / 90);
			const h = 68 + p.hue;
			const soft = self(0.5, p.softness);
			// Intentionally almost featureless: the grain overlay does the work,
			// and this recipe is what "just give me a neutral warm backdrop"
			// means. Its complexity is the lowest of the twelve for that reason.
			const layers = [
				linear(rng.range(120, 200), [
					`${withAlpha(tone(0.95, 0.016 * chromaScale, h), 0.9)} 0%`,
					`${withAlpha(tone(0.9, 0.02 * chromaScale, h), 0.85)} 100%`
				]),
				radial({
					x: rng.range(20, 80),
					y: rng.range(16, 60),
					rx: 76 * (0.7 + soft * 0.7),
					ry: 58 * (0.7 + soft * 0.7),
					color: tone(0.99, 0.01, h + 8),
					alpha: 0.34,
					fade: 100
				})
			];
			return { layers, base: tone(0.93, 0.018, h) };
		}
	}
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
