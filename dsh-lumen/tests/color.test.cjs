"use strict";
/**
 * Colour parsing, contrast and the readability floor.
 *
 * The parsing tests are mostly about *refusal*: the wash depends on a strict
 * parse of the theme's own token, and a parser that silently accepts garbage
 * produces a wrong colour in the UI rather than an error anyone can see.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	parseColor,
	formatColor,
	withAlpha,
	relativeLuminance,
	contrastRatio,
	compositeOver,
	alphaForContrast,
	estimateImageLuminance,
	mixOklab,
	quantile,
	pixelLuminanceEstimate,
	NEUTRAL_LUMINANCE,
	DEFAULT_LUMINANCE_QUANTILE
} = require("../src/color.cjs");

test("parses every syntax this plugin emits or accepts", () => {
	assert.deepEqual(parseColor("#abc"), { r: 170, g: 187, b: 204, a: 1 });
	assert.deepEqual(parseColor("#aabbcc"), { r: 170, g: 187, b: 204, a: 1 });
	assert.deepEqual(parseColor("#aabbcc80").a, 128 / 255);
	assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
	assert.deepEqual(parseColor("rgba(1, 2, 3, 0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
	assert.deepEqual(parseColor("rgb(10 20 30 / 0.25)"), { r: 10, g: 20, b: 30, a: 0.25 });
	assert.deepEqual(parseColor("rgb(50%, 50%, 50%)").r, 127.5);
	assert.equal(parseColor("hsl(0, 100%, 50%)").r, 255);
	assert.equal(parseColor("transparent").a, 0);
	assert.equal(parseColor("  #FFF  ").r, 255);
});

test("refuses anything that is not a colour, rather than guessing", () => {
	for (const bad of ["", "   ", "not-a-colour", "#12", "#12345", "rgb(1,2)", "rgb(a,b,c)", "url(#x)", null, undefined, 42, {}]) {
		assert.equal(parseColor(bad), null, `accepted ${JSON.stringify(bad)}`);
	}
});

test("formatting emits a canonical string and drops a redundant alpha", () => {
	assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 1 }), "rgb(1, 2, 3)");
	assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 0.5 }), "rgba(1, 2, 3, 0.5)");
	assert.equal(formatColor({ r: 1.4, g: 2.6, b: 3.5, a: 1 }), "rgb(1, 3, 4)");
	assert.equal(withAlpha({ r: 9, g: 9, b: 9 }, 0.25), "rgba(9, 9, 9, 0.25)");
});

test("relative luminance and contrast match the WCAG reference points", () => {
	assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
	assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-9);
	// The two canonical ratios from the specification: black on white is 21:1,
	// and #767676 on white is the textbook "just passes AA body text" pair.
	assert.ok(Math.abs(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) - 21) < 1e-9);
	assert.ok(Math.abs(contrastRatio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }) - 4.5) < 0.1);
	assert.equal(contrastRatio({ r: 7, g: 7, b: 7 }, { r: 7, g: 7, b: 7 }), 1);
});

test("contrast is symmetric", () => {
	const a = { r: 10, g: 40, b: 90 };
	const b = { r: 200, g: 180, b: 120 };
	assert.equal(contrastRatio(a, b), contrastRatio(b, a));
});

test("compositing follows source-over", () => {
	const over = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
	assert.equal(Math.round(over.r), 128);
	assert.equal(over.a, 1);
	const opaque = compositeOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255 });
	assert.deepEqual({ r: opaque.r, g: opaque.g, b: opaque.b }, { r: 10, g: 20, b: 30 });
});

test("mixOklab works on the 0-255 scale the rest of this module uses", () => {
	const mid = mixOklab({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
	assert.ok(mid.r > 90 && mid.r < 115, `midpoint for black->white was ${mid.r.toFixed(1)}, not mid grey`);
	const a = { r: 10, g: 20, b: 30 };
	const b = { r: 200, g: 100, b: 50 };
	assert.ok(Math.abs(mixOklab(a, b, 0).r - a.r) < 1);
	assert.ok(Math.abs(mixOklab(a, b, 1).b - b.b) < 1);
	assert.ok(Math.abs(mixOklab(a, b, 1).r - b.r) < 1);
});

test("mixOklab stays on a perceptual path where sRGB interpolation would not", () => {
	// Black -> white at Oklab L=0.5 is linear-light 0.125 (for neutrals L is the
	// cube root of linear light), i.e. a relative luminance of ~0.125. sRGB's own
	// midpoint at 127.5 is ~0.215 — visibly lighter than the true midpoint.
	const mid = mixOklab({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
	const lightness = relativeLuminance(mid);
	const srgbLightness = relativeLuminance({ r: 127.5, g: 127.5, b: 127.5 });
	assert.ok(Math.abs(lightness - 0.125) < 0.015, `Oklab midpoint luminance was ${lightness.toFixed(4)}`);
	assert.ok(srgbLightness > lightness + 0.05, "sRGB interpolation should be visibly lighter at the midpoint");
});

test("the readability floor delivers the contrast it promises", () => {
	// Checked against REAL composites over real colours, not against this
	// module's own arithmetic. Re-deriving the composite from the same formula
	// the solver uses proves nothing: it passes even when that formula reads the
	// wallpaper's luminance on the wrong scale — which is exactly the bug this
	// test exists for (a relative luminance is linear light, a channel value is
	// gamma-encoded, and the two differ by ~70/255 in the midtones).
	const themes = [
		{ base: { r: 20, g: 20, b: 24, a: 1 }, label: { r: 235, g: 235, b: 240, a: 1 }, name: "dark" },
		{ base: { r: 255, g: 255, b: 255, a: 1 }, label: { r: 17, g: 17, b: 17, a: 1 }, name: "light" }
	];
	let checked = 0;
	for (const theme of themes) {
		for (const grey of [0, 16, 32, 48, 64, 96, 128, 160, 192, 224, 240, 255]) {
			const backdrop = { r: grey, g: grey, b: grey, a: 1 };
			const alpha = alphaForContrast(theme.base, theme.label, relativeLuminance(backdrop), 4.5, 1);
			const washed = parseColor(withAlpha(theme.base, alpha));
			const delivered = contrastRatio(compositeOver(washed, backdrop), theme.label);
			checked += 1;
			assert.ok(delivered >= 4.5, `${theme.name} theme over grey ${grey}: alpha ${alpha} delivered ${delivered.toFixed(2)}:1`);
		}
	}
	assert.ok(checked >= 24, `only ${checked} combinations were checked`);
});

test("the readability floor is minimal, not merely sufficient", () => {
	// A floor that simply asked for full opacity would also be "safe"; what makes
	// it usable is that it returns the *first* alpha that works.
	const canvas = { r: 20, g: 20, b: 24, a: 1 };
	const label = { r: 235, g: 235, b: 240, a: 1 };
	const backdrop = { r: 200, g: 200, b: 200, a: 1 };
	const alpha = alphaForContrast(canvas, label, relativeLuminance(backdrop), 4.5, 1);
	const at = (a) => contrastRatio(compositeOver(parseColor(withAlpha(canvas, a)), backdrop), label);
	assert.ok(at(alpha) >= 4.5, "the solved alpha does not clear the target");
	assert.ok(alpha < 0.9, `the solved alpha is not minimal: ${alpha}`);
	// And a slightly thinner wash genuinely fails, so the value is on the edge
	// rather than comfortably above it.
	assert.ok(at(Math.max(0, alpha - 0.06)) < 4.5, "a thinner wash would also have passed");
});

test("an already-readable combination asks for no wash", () => {
	// Dark canvas, light label: readable with zero wash.
	const alpha = alphaForContrast({ r: 18, g: 18, b: 20, a: 1 }, { r: 240, g: 240, b: 245, a: 1 }, 0.05, 4.5, 1);
	assert.equal(alpha, 0);
});

test("the readability floor never exceeds its ceiling", () => {
	// A bright wallpaper behind a light label: clearing 4.5 is impossible, so the
	// answer must be the ceiling rather than a value above it.
	const alpha = alphaForContrast({ r: 250, g: 250, b: 250, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, 0.95, 4.5, 0.9);
	assert.equal(alpha, 0.9);
});

test("estimating a gradient stack measures area, not stop count", () => {
	// 40 near-white pinpricks must not outweigh a dark field: coverage is the
	// integral, and each pinprick is ~0.03% of the viewport.
	const stars = Array.from({ length: 40 }, () => "radial-gradient(1% 1% at 50% 50%, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0) 100%)").join(", ");
	const dark = estimateImageLuminance(stars, parseColor("rgb(10, 10, 14)"));
	assert.ok(dark < 0.05, `a starfield measured ${dark.toFixed(3)} — it should be nearly black`);

	const wash = "linear-gradient(160deg, rgba(240, 240, 240, 1) 0%, rgba(230, 230, 230, 1) 100%)";
	const bright = estimateImageLuminance(wash, parseColor("rgb(240, 240, 240)"));
	assert.ok(bright > 0.8, `a light gradient measured ${bright.toFixed(3)}`);

	// A big blob covers most of the viewport and must dominate.
	const blob = "radial-gradient(60% 60% at 50% 50%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 100%)";
	const mixed = estimateImageLuminance(blob, parseColor("rgb(0, 0, 0)"));
	assert.ok(mixed > 0.5, `a large bright blob measured ${mixed.toFixed(3)}`);
});

test("estimating an unparsable value falls back to the neutral assumption", () => {
	const value = estimateImageLuminance('url("https://example.com/a.jpg")', null);
	assert.ok(value > 0.3 && value < 0.5, `fallback was ${value}`);
	assert.ok(estimateImageLuminance("", null) > 0.3);
});

test("estimating respects the declared fade distance", () => {
	const tight = estimateImageLuminance("radial-gradient(60% 60% at 50% 50%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 20%)", parseColor("rgb(0, 0, 0)"));
	const loose = estimateImageLuminance("radial-gradient(60% 60% at 50% 50%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 100%)", parseColor("rgb(0, 0, 0)"));
	assert.ok(loose > tight, "a wider fade should cover more area");
});

test("quantile takes the nearest rank, and clamps rather than extrapolating", () => {
	// Nearest rank, not interpolation: the answer is always one of the samples,
	// which keeps the result a real pixel's brightness rather than an average of
	// two that appears on no pixel.
	assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
	assert.equal(quantile([1, 2, 3, 4], 0.75), 3);
	assert.equal(quantile([1, 2, 3, 4], 1), 4);
	assert.equal(quantile([1, 2, 3, 4], 0), 1, "q=0 must still return a sample, not an empty slot");
	// Out of range clamps instead of reading past the end.
	assert.equal(quantile([5, 6], 2), 6);
	assert.equal(quantile([5, 6], -1), 5);
	// Unsorted input, a single sample, and nothing at all.
	assert.equal(quantile([4, 1, 3, 2], 0.5), 2, "the input was not sorted before ranking");
	assert.equal(quantile([7], 0.75), 7);
	assert.equal(quantile([], 0.5), 0);
	assert.equal(quantile(null, 0.5), 0);
});

test("the pixel estimate reads the upper quartile, not the mean", () => {
	// THE POINT OF THE QUANTILE. A picture that is half black and half white has
	// a mean luminance of 0.5 — solve the wash for 0.5 and the white half is
	// still unreadable. The upper quartile answers 1, which protects the part
	// that actually threatens the text.
	const half = [];
	for (let i = 0; i < 50; i += 1) half.push(0, 0, 0, 255);
	for (let i = 0; i < 50; i += 1) half.push(255, 255, 255, 255);
	assert.equal(pixelLuminanceEstimate(half), 1, "a half-white picture measured as only half bright");
	// The mean is what a naive implementation would report; assert the two really
	// do differ, so the test cannot pass by accident.
	const samples = [];
	for (let i = 0; i + 3 < half.length; i += 4) samples.push(relativeLuminance({ r: half[i], g: half[i + 1], b: half[i + 2] }));
	assert.ok(quantile(samples, 0.5) < 0.6, "the median should sit near the middle, unlike the quartile");
	assert.equal(DEFAULT_LUMINANCE_QUANTILE, 0.75);

	// A flat picture collapses the quantile onto the mean, so nothing is
	// over-protected for free.
	const grey = [];
	for (let i = 0; i < 100; i += 1) grey.push(128, 128, 128, 255);
	const flat = pixelLuminanceEstimate(grey);
	assert.ok(flat > 0.2 && flat < 0.23, `mid-grey measured as ${flat}`);
	assert.ok(Math.abs(pixelLuminanceEstimate(grey, { quantile: 0.5 }) - flat) < 1e-9, "a flat picture should not care about the quantile");
});

test("the pixel estimate refuses to measure what is not there", () => {
	// `null` means "no measurement", which the caller reads as "fall back". It is
	// kept distinct from 0, because 0 is pure black — the one value at which the
	// readability floor stops protecting anything.
	for (const input of [null, undefined, 5, "rgba", {}]) {
		assert.equal(pixelLuminanceEstimate(input), NEUTRAL_LUMINANCE, `${JSON.stringify(input)} did not fall back`);
	}
	// Fully transparent pixels carry no colour, so a transparent buffer is
	// unmeasurable rather than black.
	const clear = [];
	for (let i = 0; i < 100; i += 1) clear.push(0, 0, 0, 0);
	assert.equal(pixelLuminanceEstimate(clear), NEUTRAL_LUMINANCE, "a transparent buffer was counted as black");

	// Black and white are real measurements and must be reported as such.
	const black = [];
	const white = [];
	for (let i = 0; i < 100; i += 1) {
		black.push(0, 0, 0, 255);
		white.push(255, 255, 255, 255);
	}
	assert.equal(pixelLuminanceEstimate(black), 0);
	assert.equal(pixelLuminanceEstimate(white), 1);
});

test("a transparent pixel is skipped rather than read as black", () => {
	// A PNG with an alpha channel is full of transparent pixels whose RGB slots
	// are whatever the encoder left there — usually zero. Counting them turns a
	// mostly-empty picture into a black one and switches the readability floor
	// off for a picture that is actually bright.
	const buffer = [];
	for (let i = 0; i < 90; i += 1) buffer.push(0, 0, 0, 0); // transparent padding
	for (let i = 0; i < 10; i += 1) buffer.push(255, 255, 255, 255); // the actual subject
	assert.equal(pixelLuminanceEstimate(buffer), 1, "the transparent majority dragged the measurement down");
});
