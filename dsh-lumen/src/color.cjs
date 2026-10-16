"use strict";
/**
 * Colour parsing, formatting and the readability guard.
 *
 * Deliberately small and total: every function here returns a value for every
 * input, and nothing throws. The plugin runs inside the DSH shell, where a
 * throw during boot takes the whole settings section down with it, so the
 * cheaper failure mode is "a wallpaper that looks slightly off" — never an
 * exception.
 *
 * The one non-obvious rule is about *which* syntax everything is emitted in.
 * The wash works by replacing `--dsw-alias-bg-base` with a translucent
 * version of the theme's own colour, and a translucent token that keeps the
 * theme's hue is only produced from a strict parse. So this module
 * round-trips aggressively and always emits the classic comma-separated
 * `rgba(r, g, b, a)` form, which every consumer in the chain understands.
 */

const { linearToSrgb, srgbToOklab } = require("./oklab.cjs");

const NAMED = {
	transparent: { r: 0, g: 0, b: 0, a: 0 },
	black: { r: 0, g: 0, b: 0, a: 1 },
	white: { r: 255, g: 255, b: 255, a: 1 },
	gray: { r: 128, g: 128, b: 128, a: 1 },
	grey: { r: 128, g: 128, b: 128, a: 1 }
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v) => Math.round(v * 1000) / 1000;
// Percentage channels are scaled by 2.55, which is not exact in binary: 50% of
// 255 lands on 127.49999999999999. Rounding to three decimals makes the value
// comparable and stable, and three decimals is far below a display step.
const roundChannel = (v) => Math.round(v * 1000) / 1000;

/**
 * What to assume when a picture's brightness genuinely cannot be measured.
 *
 * A WCAG *relative luminance*, i.e. the sRGB channel ~173 — appreciably
 * brighter than mid-grey (0.216). Deliberately high because the two error
 * directions are not symmetric: over-estimating costs a slightly heavier wash,
 * while under-estimating is how a custom photo ends up with unreadable text.
 *
 * Named rather than repeated so the fallback cannot drift between the three
 * places that need it (the gradient estimator, the pixel estimator, and the
 * engine's per-item resolution).
 */
const NEUTRAL_LUMINANCE = 0.42;

/**
 * Which quantile of a picture's pixel luminances stands for the picture.
 * See `pixelLuminanceEstimate` for why this is above the mean.
 */
const DEFAULT_LUMINANCE_QUANTILE = 0.75;

/** Split an argument list on commas *or* whitespace, dropping a leading slash. */
function splitArgs(body) {
	return body
		.replace(/\//g, " ")
		.trim()
		.split(/[\s,]+/)
		.filter((part) => part.length > 0);
}

/**
 * `97%` -> 0.97, `0.5` -> 0.5.
 * @returns {number|null} `null` when the token is not a number, so callers can
 *   refuse the whole colour rather than defaulting a channel to zero — a
 *   malformed colour silently becoming black is worse than being refused.
 */
function parseAlphaToken(token) {
	if (token === undefined) return 1;
	if (token.endsWith("%")) {
		const n = Number(token.slice(0, -1));
		return Number.isFinite(n) ? clamp(n / 100, 0, 1) : null;
	}
	const n = Number(token);
	return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/**
 * `50%` -> 127.5, `200` -> 200 (both on the 0-255 display scale).
 * @returns {number|null} `null` for anything not a number.
 */
function parseChannelToken(token) {
	if (typeof token !== "string") return null;
	if (token.endsWith("%")) {
		const n = Number(token.slice(0, -1));
		return Number.isFinite(n) ? roundChannel(clamp(n * 2.55, 0, 255)) : null;
	}
	const n = Number(token);
	return Number.isFinite(n) ? roundChannel(clamp(n, 0, 255)) : null;
}

function hueToRgb(p, q, t) {
	let tt = t;
	if (tt < 0) tt += 1;
	if (tt > 1) tt -= 1;
	if (tt < 1 / 6) return p + (q - p) * 6 * tt;
	if (tt < 1 / 2) return q;
	if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
	return p;
}

function hslToRgb(h, s, l) {
	const hue = ((h % 360) + 360) % 360 / 360;
	const sat = clamp(s, 0, 1);
	const lum = clamp(l, 0, 1);
	if (sat === 0) {
		const v = lum * 255;
		return { r: v, g: v, b: v };
	}
	const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
	const p = 2 * lum - q;
	return {
		r: hueToRgb(p, q, hue + 1 / 3) * 255,
		g: hueToRgb(p, q, hue) * 255,
		b: hueToRgb(p, q, hue - 1 / 3) * 255
	};
}

/**
 * Parse any CSS colour this plugin can be handed into `{r,g,b,a}` with r/g/b
 * on 0-255 and a on 0-1.
 *
 * Returns `null` for anything unrecognised so callers can distinguish "not a
 * colour" from "black" — the token-override path relies on that difference to
 * decide between falling back and leaking a wrong colour into the theme.
 */
function parseColor(input) {
	if (input === null || input === undefined) return null;
	if (typeof input === "object" && typeof input.r === "number") {
		return { r: clamp(input.r, 0, 255), g: clamp(input.g, 0, 255), b: clamp(input.b, 0, 255), a: clamp(input.a === undefined ? 1 : input.a, 0, 1) };
	}
	if (typeof input !== "string") return null;
	const text = input.trim().toLowerCase();
	if (text.length === 0) return null;
	if (Object.prototype.hasOwnProperty.call(NAMED, text)) return { ...NAMED[text] };

	if (text.charCodeAt(0) === 35) {
		const hex = text.slice(1);
		const isHex = /^[0-9a-f]+$/.test(hex);
		if (!isHex) return null;
		const expand = (c) => parseInt(c + c, 16);
		if (hex.length === 3 || hex.length === 4) {
			return {
				r: expand(hex[0]),
				g: expand(hex[1]),
				b: expand(hex[2]),
				a: hex.length === 4 ? expand(hex[3]) / 255 : 1
			};
		}
		if (hex.length === 6 || hex.length === 8) {
			return {
				r: parseInt(hex.slice(0, 2), 16),
				g: parseInt(hex.slice(2, 4), 16),
				b: parseInt(hex.slice(4, 6), 16),
				a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
			};
		}
		return null;
	}

	const open = text.indexOf("(");
	if (open < 0 || !text.endsWith(")")) return null;
	const fn = text.slice(0, open);
	const args = splitArgs(text.slice(open + 1, -1));

	if (fn === "rgb" || fn === "rgba") {
		if (args.length < 3) return null;
		const r = parseChannelToken(args[0]);
		const g = parseChannelToken(args[1]);
		const b = parseChannelToken(args[2]);
		const a = parseAlphaToken(args[3]);
		if (r === null || g === null || b === null || a === null) return null;
		return { r, g, b, a };
	}
	if (fn === "hsl" || fn === "hsla") {
		if (args.length < 3) return null;
		const h = Number(String(args[0]).replace(/deg$/, ""));
		const s = String(args[1]).endsWith("%") ? Number(args[1].slice(0, -1)) / 100 : Number(args[1]);
		const l = String(args[2]).endsWith("%") ? Number(args[2].slice(0, -1)) / 100 : Number(args[2]);
		const a = parseAlphaToken(args[3]);
		if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l) || a === null) return null;
		const rgb = hslToRgb(h, s, l);
		return { r: rgb.r, g: rgb.g, b: rgb.b, a };
	}
	return null;
}

/** Canonical CSS string. Integer channels, alpha only when it is not opaque. */
function formatColor(color) {
	const a = clamp(color.a === undefined ? 1 : color.a, 0, 1);
	if (a >= 0.999) return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
	return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${round(a)})`;
}

/** Same colour at a different alpha. */
function withAlpha(color, alpha) {
	return formatColor({ r: color.r, g: color.g, b: color.b, a: clamp(alpha, 0, 1) });
}

/** WCAG 2.1 relative luminance (0 = black, 1 = white). */
function relativeLuminance(color) {
	const channel = (v) => {
		const s = clamp(v, 0, 255) / 255;
		return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.1 contrast ratio, 1 (identical) .. 21 (black on white). */
function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

/** Source-over compositing of a translucent colour onto an opaque backdrop. */
function compositeOver(fg, bg) {
	const a = clamp(fg.a === undefined ? 1 : fg.a, 0, 1);
	return {
		r: fg.r * a + bg.r * (1 - a),
		g: fg.g * a + bg.g * (1 - a),
		b: fg.b * a + bg.b * (1 - a),
		a: 1
	};
}

/** Perceived lightness of a colour, 0..1, via Oklab L. */
function perceptualLightness(color) {
	return srgbToOklab(clamp(color.r, 0, 255) / 255, clamp(color.g, 0, 255) / 255, clamp(color.b, 0, 255) / 255).L;
}

/**
 * Blend two colours in Oklab.
 *
 * CHANNEL SCALE: 0-255, matching `parseColor` and `formatColor`. This is stated
 * because getting it wrong is silent — the conversions divide by 255 internally,
 * so handing them already-normalised values produces a colour pinned at white
 * instead of an error, and a caller would see "mixing black with white gives
 * white" with no clue why.
 *
 * @param {{r: number, g: number, b: number}} c1 0-255 channels
 * @param {{r: number, g: number, b: number}} c2 0-255 channels
 * @param {number} t 0 = `c1`, 1 = `c2`
 * @returns {{r: number, g: number, b: number}} 0-255 channels
 */
function mixOklab(c1, c2, t) {
	const { srgbToOklab: toLab, oklabToSrgb: toRgb } = require("./oklab.cjs");
	const a = toLab(clamp(c1.r, 0, 255) / 255, clamp(c1.g, 0, 255) / 255, clamp(c1.b, 0, 255) / 255);
	const b = toLab(clamp(c2.r, 0, 255) / 255, clamp(c2.g, 0, 255) / 255, clamp(c2.b, 0, 255) / 255);
	const out = toRgb(a.L + (b.L - a.L) * t, a.a + (b.a - a.a) * t, a.b + (b.b - a.b) * t);
	return { r: out.r * 255, g: out.g * 255, b: out.b * 255 };
}

/**
 * Raise a wash alpha until the theme's primary label stays readable on the
 * washed canvas.
 *
 * The wallpaper is the only thing in DSH that can destroy text contrast: every
 * other surface is a token the theme controls, but the backdrop is an arbitrary
 * image and the app's own canvas is washed translucent over it. So the wash
 * alpha is solved for, not guessed:
 *
 *   composited = wallpaper * (1 - a) + canvasColor * a
 *
 * Raising `a` pulls the composited colour towards the theme's own canvas colour
 * — which the theme already guarantees is readable against `label` — so the
 * smallest `a` that clears the target is provably sufficient. Solving rather
 * than stepping keeps it cheap enough to run on every slider pixel (the whole
 * point: it runs on a drag).
 *
 * LUMINANCE IS NOT A CHANNEL. Compositing happens on gamma-encoded sRGB
 * channels, but `wallpaperLuminance` is a WCAG *relative luminance* — linear
 * light. Feeding it in as if it were already a channel value makes the model
 * read the wallpaper as much darker than it is (a mid-grey measures 0.216
 * linear but 0.5 as a channel), so the solved alpha comes out too small and
 * the text ends up under-protected — by up to 2.4 contrast points, i.e. a
 * promised 4.5:1 delivered as ~2.1:1. `linearToSrgb` is the exact inverse of
 * the transfer function used in `relativeLuminance`, so applying it here puts
 * the two ends of the calculation back on the same scale.
 *
 * @param {object} canvasColor  the theme's raw `--dsw-alias-bg-base` colour
 * @param {object} labelColor   the theme's raw `--dsw-alias-label-primary`
 * @param {number} wallpaperLuminance  relative luminance behind the wash
 * @param {number} target       contrast ratio to clear (4.5 = WCAG AA body text)
 * @param {number} ceiling      never exceed this alpha (a wash must stay a wash)
 * @returns {number} the minimum alpha in [0, ceiling] that clears `target`
 */
function alphaForContrast(canvasColor, labelColor, wallpaperLuminance, target, ceiling) {
	const top = clamp(ceiling, 0, 1);
	// A neutral grey of the same relative luminance: the cover-weighted average
	// in `estimateImageLuminance` is a linear-light average, so its square root
	// in channel space is exactly the flat colour it is equivalent to.
	const wallpaperChannel = 255 * linearToSrgb(clamp(wallpaperLuminance, 0, 1));
	const opacityAt = (a) => {
		const composited = {
			r: canvasColor.r * a + wallpaperChannel * (1 - a),
			g: canvasColor.g * a + wallpaperChannel * (1 - a),
			b: canvasColor.b * a + wallpaperChannel * (1 - a)
		};
		return contrastRatio(composited, labelColor);
	};
	if (opacityAt(top) >= target) {
		// Bisect on [0, top]. Monotonic in `a` because both endpoints move the
		// composited colour towards the canvas, and contrast against `label` is
		// unimodal in luminance — so the *first* crossing found by bisection is
		// the answer, to 0.1% precision.
		let lo = 0;
		let hi = top;
		if (opacityAt(0) >= target) return 0;
		for (let i = 0; i < 12; i += 1) {
			const mid = (lo + hi) / 2;
			if (opacityAt(mid) >= target) hi = mid;
			else lo = mid;
		}
		// Rounded UP, never to nearest: the returned value is a safety floor, and
		// rounding it down by a thousandth would hand back an alpha that misses
		// the target it was solved to hit.
		return Math.min(top, Math.ceil(hi * 1000) / 1000);
	}
	return round(top);
}

/**
 * Split a `background-image` value into its top-level gradient layers.
 *
 * A naive `split(",")` is wrong — every colour stop contains commas — so this
 * scans for each `-gradient(` and walks its parentheses to find the matching
 * close. Layers come back in painting order (first = topmost).
 */
function scanGradientLayers(cssText) {
	const layers = [];
	const suffix = "-gradient(";
	let index = 0;
	while (index < cssText.length) {
		const hit = cssText.indexOf(suffix, index);
		if (hit < 0) break;
		let nameStart = hit;
		while (nameStart > 0 && /[a-z]/i.test(cssText[nameStart - 1])) nameStart -= 1;
		let depth = 0;
		let cursor = hit + suffix.length - 1;
		for (; cursor < cssText.length; cursor += 1) {
			const ch = cssText[cursor];
			if (ch === "(") depth += 1;
			else if (ch === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		layers.push({
			kind: cssText.slice(nameStart, hit),
			inner: cssText.slice(hit + suffix.length, cursor)
		});
		index = cursor + 1;
	}
	return layers;
}

/**
 * How much of the viewport a layer actually paints, as a 0..1 fraction.
 *
 * This is the correction that makes the estimate usable. Counting stops (the
 * obvious approach) says `starfield` is a bright wallpaper: it has 42 stops and
 * they are nearly white. It is in fact one of the darkest recipes here, because
 * each of those 42 stops covers about three ten-thousandths of the screen. Area
 * — not stop count — is what the eye integrates, so area is what gets measured:
 * a radial layer's coverage follows from its declared radii and the percentage
 * at which it fades out, and a linear/conic layer is treated as covering
 * everything at its stops' mean alpha.
 */
function layerCoverage(layer) {
	const stops = layer.inner.match(/rgba?\([^)]*\)/gi) || [];
	if (stops.length === 0) return { coverage: 0, color: null };
	let alphaSum = 0;
	let parsedCount = 0;
	let centerColor = null;
	for (let i = 0; i < stops.length; i += 1) {
		const parsed = parseColor(stops[i]);
		if (parsed === null) continue;
		if (centerColor === null) centerColor = parsed;
		alphaSum += parsed.a;
		parsedCount += 1;
	}
	if (parsedCount === 0 || centerColor === null) return { coverage: 0, color: null };
	const meanAlpha = alphaSum / parsedCount;
	if (layer.kind !== "radial") {
		return { coverage: clamp(meanAlpha, 0, 1), color: centerColor };
	}
	// `radial-gradient(<rx>% <ry>% at <x>% <y>%, …)` — the size pair sits before
	// the first colour stop. A single percentage means a circle.
	const header = layer.inner.slice(0, layer.inner.search(/rgba?\(/i));
	const percents = (header.match(/(\d+(?:\.\d+)?)%/g) || []).map((p) => Number(p.slice(0, -1)));
	if (percents.length === 0) return { coverage: clamp(meanAlpha, 0, 1), color: centerColor };
	const rx = (percents[0] || 50) / 100;
	const ry = (percents.length >= 2 ? percents[1] : percents[0]) / 100;
	// Where the blob reaches zero alpha — the last percentage in the final stop.
	const tail = layer.inner.slice(layer.inner.lastIndexOf(",") + 1);
	const tailPercent = tail.match(/(\d+(?:\.\d+)?)%/);
	const fade = tailPercent === null ? 1 : clamp(Number(tailPercent[1]) / 100, 0, 1);
	const area = Math.PI * rx * ry * fade * fade;
	return { coverage: clamp(area * meanAlpha, 0, 1), color: centerColor };
}

/**
 * Estimate how bright a `background-image` declaration will render.
 *
 * The readability floor needs to know which way the picture leans, and for a
 * stack of gradients that is answerable without rasterising anything: every
 * stop is already written down. Layers are composited bottom-up — each one
 * covering `coverage` of the viewport with its centre colour and leaving the
 * rest of the layer below showing — which is the same order the browser paints
 * them in, just collapsed to a single average.
 *
 * The result deliberately errs BRIGHT: a higher estimated luminance produces a
 * heavier wash, which protects text. Over-protecting costs a little wallpaper
 * legibility; under-protecting costs the user their ability to read the app.
 *
 * A raster picture cannot be sampled this way; the caller substitutes a
 * constant for those (see `engine.itemToBackground`).
 *
 * @param {string} cssText the value assigned to `background-image`
 * @param {object|null} baseColor the layer's `background-color`, if any
 * @returns {number} mean relative luminance, 0..1
 */
function estimateImageLuminance(cssText, baseColor) {
	let accumulated = baseColor !== null && baseColor !== undefined ? relativeLuminance(baseColor) : NEUTRAL_LUMINANCE;
	if (typeof cssText !== "string" || cssText.length === 0) return clamp(accumulated, 0, 1);
	const layers = scanGradientLayers(cssText);
	if (layers.length === 0) {
		// Not a gradient stack we understand (a `url(...)`, most likely) — fall
		// back to the neutral assumption.
		return clamp(accumulated, 0, 1);
	}
	for (let i = layers.length - 1; i >= 0; i -= 1) {
		const layer = layerCoverage(layers[i]);
		if (layer.coverage <= 0 || layer.color === null) continue;
		accumulated = relativeLuminance(layer.color) * layer.coverage + accumulated * (1 - layer.coverage);
	}
	return clamp(accumulated, 0, 1);
}

/**
 * The `q`-quantile of a sample, by nearest rank.
 *
 * Nearest rank rather than an interpolating definition on purpose: every value
 * this returns is then an actual luminance that some pixel really had, which is
 * what makes "the picture is this bright" a defensible claim about the picture
 * rather than about an average nobody can point at.
 */
function quantile(values, q) {
	if (!Array.isArray(values) || values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const rank = clamp(Math.ceil(clamp(q === undefined ? 0.5 : q, 0, 1) * sorted.length), 1, sorted.length);
	return sorted[rank - 1];
}

/**
 * Estimate the relative luminance a raster picture presents to the wash.
 *
 * WHY THE UPPER QUARTILE RATHER THAN THE MEAN
 *
 * The mean answers "how bright is this picture on average", which is the wrong
 * question. The wash has to keep *text* legible, and text sits on whatever part
 * of the picture is behind it — so what matters is how bright the picture is in
 * the regions bright enough to threaten contrast, not how bright it is overall.
 *
 * A picture that is half black and half white has a mean luminance of 0.5, and
 * a wash solved for 0.5 leaves the white half completely unreadable. The upper
 * quartile answers 1.0 there, which is the protective answer. On a flat picture
 * the quantile collapses onto the mean, so nothing is over-protected for free.
 *
 * This errs bright in exactly the direction `estimateImageLuminance` already
 * documents: over-protecting costs a slightly heavier wash, under-protecting
 * costs the user their ability to read the app.
 *
 * Fully transparent pixels are skipped — a cut-out PNG's empty area is not part
 * of the picture, and counting it as black would drag the estimate down. So is
 * any entry whose channels do not read as numbers, which keeps the return value
 * a real luminance even when the input is not really a pixel buffer.
 *
 * @param {ArrayLike<number>} rgba RGBA bytes, four per pixel
 * @param {object} [options] `quantile` overrides the upper quartile
 * @returns {number} relative luminance, 0..1
 */
function pixelLuminanceEstimate(rgba, options) {
	const o = options || {};
	const q = typeof o.quantile === "number" ? o.quantile : DEFAULT_LUMINANCE_QUANTILE;
	if (rgba === null || rgba === undefined || typeof rgba.length !== "number") return NEUTRAL_LUMINANCE;
	const samples = [];
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		if (rgba[i + 3] === 0) continue;
		const value = relativeLuminance({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] });
		// A non-numeric channel is skipped rather than sampled. `length` alone is
		// not a shape check — a string has one — and one unreadable channel would
		// otherwise poison the whole estimate: `clamp(NaN, 0, 1)` is NaN, not a
		// bound, so the caller would receive NaN from a function documented to
		// return a number in 0..1. Skipping degrades to "fewer samples", and an
		// empty set already has a defined answer.
		if (!Number.isFinite(value)) continue;
		samples.push(value);
	}
	if (samples.length === 0) return NEUTRAL_LUMINANCE;
	return clamp(quantile(samples, q), 0, 1);
}

module.exports = {
	parseColor,
	formatColor,
	withAlpha,
	relativeLuminance,
	contrastRatio,
	compositeOver,
	perceptualLightness,
	mixOklab,
	alphaForContrast,
	estimateImageLuminance,
	quantile,
	pixelLuminanceEstimate,
	NEUTRAL_LUMINANCE,
	DEFAULT_LUMINANCE_QUANTILE
};
