"use strict";
/**
 * Oklab / OKLCH conversions.
 *
 * The recipes are only reproducible if the colour maths is, so these are
 * round-trip and gamut-boundary properties rather than pinned literals: a
 * pinned hex would break on any legitimate refactor and would not catch the
 * failure that actually matters (a conversion that drifts out of gamut).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	srgbToOklab,
	oklabToSrgb,
	oklabToOklch,
	oklchToSrgb,
	oklabToLinearSrgb
} = require("../src/oklab.cjs");

/** sRGB 0-255 -> Oklab. */
function lab(r, g, b) {
	return srgbToOklab(r / 255, g / 255, b / 255);
}

test("srgb -> oklab -> srgb round-trips to within a 1/255 step", () => {
	const samples = [
		[0, 0, 0],
		[255, 255, 255],
		[18, 52, 86],
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[120, 200, 40],
		[7, 3, 240]
	];
	for (const [r, g, b] of samples) {
		const back = oklabToSrgb(...Object.values(lab(r, g, b)));
		assert.ok(Math.abs(back.r * 255 - r) <= 1, `red drifted for ${r},${g},${b}: ${back.r * 255}`);
		assert.ok(Math.abs(back.g * 255 - g) <= 1, `green drifted for ${r},${g},${b}: ${back.g * 255}`);
		assert.ok(Math.abs(back.b * 255 - b) <= 1, `blue drifted for ${r},${g},${b}: ${back.b * 255}`);
	}
});

test("white and black land at the ends of the lightness axis", () => {
	assert.ok(lab(255, 255, 255).L > 0.99, "white should be ~1.0 in L");
	assert.ok(Math.abs(lab(0, 0, 0).L) < 0.01, "black should be ~0.0 in L");
});

test("a neutral grey has negligible chroma", () => {
	const grey = lab(128, 128, 128);
	assert.ok(Math.sqrt(grey.a * grey.a + grey.b * grey.b) < 0.005, "grey picked up chroma");
});

test("constant-L OKLCH survives the sRGB round trip at every level", () => {
	// The claim Oklab makes is that L is the lightness you get back. If a recipe
	// asks for six stops 0.12 apart, it must receive six stops 0.12 apart.
	for (const L of [0.2, 0.32, 0.44, 0.56, 0.68, 0.8]) {
		const rgb = oklchToSrgb(L, 0.02, 260);
		const back = srgbToOklab(rgb.r, rgb.g, rgb.b);
		assert.ok(Math.abs(back.L - L) < 0.02, `L drifted from ${L} to ${back.L.toFixed(4)}`);
	}
});

test("even L steps are not the same as even sRGB steps (the reason this module exists)", () => {
	const lightnessOf = (channel) => srgbToOklab(channel, channel, channel).L;
	/** max/min consecutive delta — how uneven a ramp is. */
	const unevenness = (series) => {
		const deltas = [];
		for (let i = 1; i < series.length; i += 1) deltas.push(series[i] - series[i - 1]);
		return Math.max(...deltas) / Math.min(...deltas);
	};
	const srgbRamp = [0, 51, 102, 153, 204, 255].map((v) => lightnessOf(v / 255));
	const oklchRamp = [0.2, 0.32, 0.44, 0.56, 0.68, 0.8];
	assert.ok(
		unevenness(srgbRamp) > 1.8,
		`an even sRGB ramp should be perceptually uneven, unevenness was ${unevenness(srgbRamp).toFixed(2)}`
	);
	// Exact equality is not available here: 0.32 - 0.2 is not 0.12 in binary.
	assert.ok(Math.abs(unevenness(oklchRamp) - 1) < 1e-9, "an even OKLCH ramp is even by construction");
});

test("out-of-gamut requests come back inside sRGB without changing hue much", () => {
	// A fully saturated OKLCH cyan is outside sRGB; the gamut map must pull
	// chroma down rather than clip a channel.
	const mapped = oklchToSrgb(0.7, 0.4, 195);
	for (const channel of [mapped.r, mapped.g, mapped.b]) {
		assert.ok(channel >= 0 && channel <= 1, "channel escaped 0..1");
	}
	const back = oklabToOklch(...Object.values(srgbToOklab(mapped.r, mapped.g, mapped.b)));
	const hueDelta = Math.abs(((back.h - 195 + 540) % 360) - 180);
	assert.ok(hueDelta < 12, `hue shifted by ${hueDelta.toFixed(1)} degrees`);
	// And the request was genuinely clipped: chroma must have been reduced.
	assert.ok(back.C < 0.4 - 0.01, "chroma was not reduced for an out-of-gamut request");
});

test("lightness beyond 1 is clamped, not wrapped", () => {
	const white = oklabToSrgb(4, 0, 0);
	assert.equal(white.r, 1);
	assert.equal(white.g, 1);
	assert.equal(white.b, 1);
});

test("linear-srgb helper agrees with the polar helpers", () => {
	const linear = oklabToLinearSrgb(0.5, 0, 0);
	const gamma = oklabToSrgb(0.5, 0, 0);
	assert.ok(Math.abs(Math.pow(linear.r, 1 / 2.4) * 1.055 - 0.055 - gamma.r) < 1e-6);
});

test("mixing lives in color.cjs, on the 0-255 scale", () => {
	// A guard against the duplicate that used to exist: two `mixOklab`s differing
	// by a factor of 255, where picking the wrong one silently returns white.
	assert.equal(require("../src/oklab.cjs").mixOklab, undefined);
	assert.equal(typeof require("../src/color.cjs").mixOklab, "function");
});
