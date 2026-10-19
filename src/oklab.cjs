"use strict";
/**
 * Oklab / OKLCH — a perceptual colour space, implemented from the published
 * specification (Björn Ottosson, 2020).
 *
 * Why this file exists at all, when CSS already knows about colours: the
 * built-in wallpapers are *generated*, and a generator that picks colours in
 * sRGB picks them badly. A "5% darker" step in sRGB is 12% darker in the dark
 * end and 2% darker in the light end — the luminance ladder comes out visibly
 * uneven, and a light-scheme wallpaper ends up muddy in the corners and blown
 * out in the middle. In Oklab the same numeric step is the same *perceived*
 * step, so "N stops brighter" means the same thing in `ivory` as in `abyss`.
 *
 * So the ladder is built in a perceptual space and converted outward, which is
 * what makes "N stops brighter" a control we can hand to a user at all: the
 * same N reads as the same step in `ivory` as in `abyss`, so one slider has one
 * meaning across every built-in recipe.
 *
 * Everything here is pure: numbers in, numbers out, no DOM, no allocation
 * beyond the returned records. That is what makes the 12 recipes testable
 * without a browser.
 */

/**
 * Linear-light sRGB channel -> gamma-encoded sRGB (0..1 both ways).
 *
 * The two endpoints are returned exactly. The transfer function is only defined
 * on [0, 1], and evaluating its upper branch at 1 yields 0.9999999999999999 in
 * binary floating point — which then makes "clamp an out-of-range lightness" not
 * actually clamp, and turns an equality assertion in a test into a mystery.
 */
function linearToSrgb(c) {
	if (c <= 0) return 0;
	if (c >= 1) return 1;
	return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Gamma-encoded sRGB channel -> linear-light (0..1 both ways). */
function srgbToLinear(c) {
	if (c <= 0) return 0;
	if (c >= 1) return 1;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Linear-light sRGB -> Oklab.
 * @param {number} r linear, 0..1
 * @param {number} g linear, 0..1
 * @param {number} b linear, 0..1
 * @returns {{L: number, a: number, b: number}} L in 0..1, a/b roughly -0.4..0.4
 */
function linearSrgbToOklab(r, g, b) {
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);
	return {
		L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
	};
}

/**
 * Oklab -> linear-light sRGB. The result is NOT gamut-mapped: channels can
 * come back outside 0..1, which is how {@link oklabToSrgb} detects the need
 * to reduce chroma.
 */
function oklabToLinearSrgb(L, a, b) {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	return {
		r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	};
}

/** Gamma-encoded sRGB (0..1 channels) -> Oklab. */
function srgbToOklab(r, g, b) {
	return linearSrgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

/**
 * Oklab -> gamma-encoded sRGB, chroma-reduced until it fits the gamut.
 *
 * Chroma reduction is preferred over channel clipping because clipping moves
 * hue: a fully saturated cyan clipped into sRGB turns visibly green. Bisecting
 * C at constant L and h keeps the colour the one that was asked for and only
 * gives up as much vividness as the display actually cannot show.
 */
function oklabToSrgb(L, a, b) {
	const inGamut = (v) => {
		const lin = oklabToLinearSrgb(L, v.a, v.b);
		return lin.r >= -1e-6 && lin.r <= 1 + 1e-6
			&& lin.g >= -1e-6 && lin.g <= 1 + 1e-6
			&& lin.b >= -1e-6 && lin.b <= 1 + 1e-6;
	};
	let lo = { a: 0, b: 0 };
	let hi = { a, b };
	if (inGamut(hi)) {
		lo = hi;
	} else if (!inGamut(lo)) {
		// Even neutral grey is out of gamut: only possible for L <0 or >1.
		lo = { a: 0, b: 0 };
	} else {
		for (let i = 0; i < 20; i += 1) {
			const mid = { a: (lo.a + hi.a) / 2, b: (lo.b + hi.b) / 2 };
			if (inGamut(mid)) lo = mid;
			else hi = mid;
		}
	}
	const lin = oklabToLinearSrgb(L, lo.a, lo.b);
	const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
	return {
		r: clamp01(linearToSrgb(clamp01(lin.r))),
		g: clamp01(linearToSrgb(clamp01(lin.g))),
		b: clamp01(linearToSrgb(clamp01(lin.b)))
	};
}

/** Oklab -> OKLCH (polar form). Hue in degrees, 0..360. */
function oklabToOklch(L, a, b) {
	const C = Math.sqrt(a * a + b * b);
	let h = (Math.atan2(b, a) * 180) / Math.PI;
	if (h < 0) h += 360;
	return { L, C, h };
}

/** OKLCH -> Oklab. */
function oklchToOklab(L, C, h) {
	const rad = (h * Math.PI) / 180;
	return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

/** OKLCH -> gamma-encoded sRGB with gamut mapping. */
function oklchToSrgb(L, C, h) {
	const lab = oklchToOklab(L, C, h);
	return oklabToSrgb(lab.L, lab.a, lab.b);
}

/**
 * NOTE: colour *blending* lives in `color.cjs` as `mixOklab`, on the 0-255
 * channel scale the rest of that module uses. It is deliberately not duplicated
 * here — the only difference would be a factor of 255, and having both invites
 * a caller to pick the wrong one and get a colour pinned at white.
 */

module.exports = {
	linearToSrgb,
	srgbToLinear,
	linearSrgbToOklab,
	oklabToLinearSrgb,
	srgbToOklab,
	oklabToSrgb,
	oklabToOklch,
	oklchToOklab,
	oklchToSrgb
};
