"use strict";
/**
 * The built-in wallpaper library — two families behind one id.
 *
 * FAMILY ONE, AND WHY IT EXISTS AT ALL: `drift` and `mist` are recipes, not
 * pictures. A recipe is a pure function `(seed, hue, softness, grain) -> CSS`:
 * same inputs, same picture, forever — which is what lets the tests pin the
 * output, lets the "shake" button produce a genuine variation, and lets the
 * rotation scheduler restore exactly the wallpaper it showed yesterday. A
 * recipe also costs no bytes and carries no licence, which is why the generated
 * family is the one that survives a package-size argument.
 *
 * FAMILY TWO: four illustrations the project's author drew for this package.
 * They are the opposite of a recipe on every count — one picture each, a few
 * hundred kilobytes each, no seed, no hue knob — and they are here because a
 * generated light blob cannot be a character. What they deliberately do NOT do
 * is grow the data model: a photo is still a `recipe`-kind item whose `ref` is
 * the recipe's id, because the picker, the rotation scheduler, the wash solver
 * and the persisted state all already work on a recipe id. `build()` returns a
 * single `url()` layer instead of a gradient stack, and everything downstream
 * treats it as one more built-in.
 *
 * A PICTURE IS SERVED, NOT INLINED. A 300KB JPEG is ~400KB of base64, and this
 * file is bundled into a browser payload with a 512KB budget — so the bytes stay
 * in `media/wallpapers/` and the host half serves them under
 * {@link WALLPAPER_URL_PREFIX}. The URL is relative and same-origin, so it
 * survives the host's per-launch port and needs no CORS arrangement.
 *
 * COLOUR OF THE GENERATED FAMILY IS COMPUTED, NOT TYPED. Every stop comes out of
 * OKLCH and is gamut-mapped into sRGB by `oklab.cjs`, so "the light version of
 * this recipe" is a real perceptual relationship rather than a hand-tuned second
 * palette. A photo's brightness cannot be computed that way — it is measured
 * once, offline, with the same definition `image.sampleLuminance` uses at import
 * time, and carried on the recipe as `luminance` (see {@link photoRecipe}).
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

/** Where the host half serves the bundled illustrations from. */
const WALLPAPER_URL_PREFIX = "/lumen/wallpaper";
/**
 * The only shape a bundled-illustration URL may have.
 *
 * Narrow on purpose, and narrower than the file system: this string is written
 * into a `background-image` declaration, so it is validated by shape like every
 * other value that reaches the DOM (`state.isSafeBackgroundImage`). No `..`, no
 * query, no protocol — a relative path with a lowercase file name.
 */
const WALLPAPER_URL_SHAPE = /^\/lumen\/wallpaper\/[a-z0-9-]+\.(jpg|jpeg|png|webp)$/;

/**
 * A bundled illustration, declared in the same shape as a recipe.
 *
 * Sharing the shape is the whole point: the panel's chip row, the playlist, the
 * scheduler and the state model all key off "a `recipe` item whose `ref` is a
 * built-in id", and none of them has to learn about pictures. What differs is
 * only the inside of `build()` — one `url()` layer instead of a gradient stack —
 * plus two facts a photograph has and a recipe does not:
 *
 *   - `luminance`, measured on the shipped file with the same definition a
 *     user's imported picture gets (64x64 area average, WCAG relative
 *     luminance, 75th percentile). Without it the readability floor would solve
 *     against the neutral constant for a picture whose brightness is a known
 *     number, and the wash would be wrong in the expensive direction.
 *   - `base`, the picture's own average colour, so the fallback painted while
 *     the JPEG loads is the wallpaper's colour rather than a black flash.
 */
function photoRecipe(spec) {
	return {
		id: spec.id,
		name: spec.name,
		scheme: "dark",
		tags: ["photo", ...spec.tags],
		/** The file name inside `media/wallpapers/`. The host half serves it. */
		photo: spec.file,
		luminance: spec.luminance,
		complexity: spec.complexity,
		defaultSoftness: NEUTRAL_TUNING.softness,
		defaultGrain: 0.2,
		build() {
			return { layers: [`url("${WALLPAPER_URL_PREFIX}/${spec.file}")`], base: spec.base };
		}
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
	photoRecipe({
		id: "whale-point-half",
		name: { zh: "夜潮", en: "Night Tide" },
		file: "whale-point-half.webp",
		tags: ["whale", "night"],
		// Every luminance below is a measurement of the shipped file, not a
		// guess: 64x64 area average, WCAG relative luminance, upper quartile —
		// the definition `image.sampleLuminance` applies to an imported picture.
		luminance: 0.132,
		base: { r: 78, g: 96, b: 133 },
		complexity: 0.55
	}),
	photoRecipe({
		id: "whale-starlit",
		name: { zh: "星海", en: "Starlit" },
		file: "whale-starlit.webp",
		tags: ["whale", "night"],
		luminance: 0.085,
		base: { r: 39, g: 51, b: 78 },
		complexity: 0.5
	}),
	photoRecipe({
		id: "whale-sunset",
		name: { zh: "黄昏", en: "Dusk" },
		file: "whale-sunset.webp",
		tags: ["whale", "warm"],
		// The brightest of the four, and the default on a fresh install — which
		// is why its complexity is the highest: it is the one picture that most
		// needs the automatic lift to keep text legible over the sky.
		luminance: 0.245,
		base: { r: 126, g: 110, b: 130 },
		complexity: 0.6
	}),
	photoRecipe({
		id: "whale-point-full",
		name: { zh: "深蓝", en: "Deep Blue" },
		file: "whale-point-full.webp",
		tags: ["whale", "blue"],
		luminance: 0.133,
		base: { r: 82, g: 103, b: 150 },
		complexity: 0.55
	})
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

/** True when `id` names a bundled illustration rather than a generated recipe. */
function isPhotoId(id) {
	const recipe = RECIPE_BY_ID.get(id);
	return recipe !== undefined && typeof recipe.photo === "string";
}

/**
 * Recipes that used to ship and no longer do, and what a stored reference to
 * one should become.
 *
 * Without this a state written by an older build keeps a `ref` that no longer
 * exists, and `normalizeItem` repairs every one of them to `RECIPES[0]` — three
 * playlist entries that were deliberately different pictures all collapse onto
 * the same one. The mapping is by *intent* (`starfield` was the night sky, so it
 * becomes the night-sky illustration), not by array position.
 */
const RETIRED_RECIPE_IDS = new Map([
	["aurora", "drift"],
	["starfield", "whale-starlit"],
	["dune", "mist"]
]);

/**
 * The recipe id a stored value should mean, or `null` when nothing can be made
 * of it. Unknown ids still land on the first recipe — "the entry means a
 * built-in wallpaper" survives, which is the same repair `normalizeItem` has
 * always done.
 */
function repairRecipeId(id) {
	if (typeof id !== "string") return null;
	if (RECIPE_BY_ID.has(id)) return id;
	return RETIRED_RECIPE_IDS.get(id) || null;
}

/**
 * Render a recipe into the two CSS values the backdrop layer needs.
 *
 * @param {{recipeId?: string, seed?: string|number, tuning?: object}} input
 * @returns {{backgroundImage: string, backgroundColor: string, scheme: string, complexity: number, recipeId: string, seed: string, luminance: number|null, photo: boolean}}
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
		seed,
		// A generated recipe has no measured brightness — the engine estimates it
		// from the gradient stack. A photograph does, and `null` here means
		// exactly that: "not measured", the same meaning it has on a state item.
		luminance: typeof recipe.luminance === "number" ? recipe.luminance : null,
		photo: typeof recipe.photo === "string"
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
	WALLPAPER_URL_PREFIX,
	WALLPAPER_URL_SHAPE,
	RETIRED_RECIPE_IDS,
	getRecipe,
	isRecipeId,
	isPhotoId,
	repairRecipeId,
	renderRecipe,
	defaultGrainFor,
	defaultSoftnessFor
};
