"use strict";
/**
 * Local image intake.
 *
 * Two things are worth pinning here, and neither is "does it produce a pretty
 * picture". The first is that a picture which does not fit is made to fit rather
 * than failing silently — the shrink-then-thin loop is the only thing standing
 * between a user's phone photo and an unannounced storage error. The second is
 * that every rejection carries one of a small set of codes, because the panel
 * turns those codes into sentences and a new code would surface to the user as
 * an untranslated string.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { prepareImage, fitWithin, sampleLuminance, DEFAULT_MAX_EDGE, MAX_INPUT_BYTES, LUMINANCE_SAMPLE_EDGE } = require("../src/image.cjs");
const { NEUTRAL_LUMINANCE } = require("../src/color.cjs");

/**
 * A canvas double.
 *
 * `toDataURL` returns a string of a requested length so the retry loop can be
 * driven precisely: the whole point of the loop is what happens when the result
 * is too big, and that is otherwise unreachable without a real encoder.
 *
 * EVERY `createElement("canvas")` RETURNS A FRESH CANVAS, because the module
 * makes two of them — the one it encodes from, and the 64x64 one it measures
 * the picture's brightness on. A double that handed back one shared canvas
 * would let the measurement resize the encoder's canvas and would fold the
 * measurement's draw into the encoder's `draws`, hiding exactly the mistake
 * worth catching. `canvas` and `draws` still resolve to the FIRST canvas, which
 * is always the encoder's, so assertions read the same as before.
 *
 * `pixelsFor(w, h)` supplies the RGBA bytes `getImageData` returns; returning
 * `null` (the default) makes `getImageData` throw, which is how the module's
 * "unmeasurable" path is reached — the same thing a tainted canvas does.
 */
function createCanvasDouble(options) {
	const o = options || {};
	const canvases = [];
	const sizeFor = typeof o.sizeFor === "function" ? o.sizeFor : () => 128;
	const pixelsFor = typeof o.pixelsFor === "function" ? o.pixelsFor : () => null;

	function makeCanvas() {
		const box = { width: 0, height: 0 };
		const draws = [];
		const context = {
			clearRect() {},
			drawImage(_image, _x, _y, w, h) {
				draws.push({ w, h });
			},
			getImageData(_x, _y, w, h) {
				const data = pixelsFor(w, h);
				if (data === null || data === undefined) throw new Error("the canvas is not readable");
				return { data, width: w, height: h };
			},
			imageSmoothingEnabled: false,
			imageSmoothingQuality: ""
		};
		const canvas = {
			get width() {
				return box.width;
			},
			set width(value) {
				box.width = value;
			},
			get height() {
				return box.height;
			},
			set height(value) {
				box.height = value;
			},
			getContext: () => context,
			toDataURL: (type, quality) => `data:${type};base64,` + "A".repeat(Math.max(0, sizeFor(box.width, box.height, quality) - 22)),
			draws,
			box,
			context
		};
		canvases.push(canvas);
		return canvas;
	}

	return (function build() {
		// The encoder's canvas is created EAGERLY, before the caller can grab a
		// reference to `draws`. Tests destructure `draws` up front and assert on it
		// after awaiting, so it has to be the live array the context pushes into —
		// a getter would hand out a detached empty array at destructuring time.
		const main = makeCanvas();
		let handed = false;
		return {
			documentImpl: {
				createElement: (tag) => {
					if (tag !== "canvas") return null;
					if (!handed) {
						handed = true;
						return main;
					}
					return makeCanvas();
				}
			},
			canvases,
			canvas: main,
			draws: main.draws
		};
	})();
}

/** A flat RGBA buffer of one colour, `count` pixels wide. */
function flatPixels(count, r, g, b, a) {
	const data = new Uint8Array(count * 4);
	for (let i = 0; i < count; i += 1) {
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = a === undefined ? 255 : a;
	}
	return data;
}


/** A decoded-bitmap double reporting the given source size. */
function createBitmap(width, height) {
	let closed = false;
	return {
		width,
		height,
		close() {
			closed = true;
		},
		get closed() {
			return closed;
		}
	};
}

test("fitWithin scales down to the long edge and never enlarges", () => {
	assert.deepEqual(fitWithin(4000, 3000, 2560), { width: 2560, height: 1920, scale: 2560 / 4000 });
	assert.deepEqual(fitWithin(3000, 4000, 2560), { width: 1920, height: 2560, scale: 2560 / 4000 });
	// A picture already inside the limit is left alone.
	assert.deepEqual(fitWithin(800, 600, 2560), { width: 800, height: 600, scale: 1 });
	assert.deepEqual(fitWithin(2560, 1440, 2560), { width: 2560, height: 1440, scale: 1 });
});

test("fitWithin never returns a zero edge or a non-number", () => {
	// A 0x0 box makes `drawImage` throw, and a thrown error mid-encode is a
	// picture the user picked and did not get.
	for (const input of [[0, 0, 2560], [1, 4000, 2560], [-5, 100, 10], [NaN, 100, 10], ["800", "600", "500"], [100, 100, 0]]) {
		const box = fitWithin(input[0], input[1], input[2]);
		assert.ok(Number.isFinite(box.width) && box.width >= 1, `width was ${box.width} for ${input}`);
		assert.ok(Number.isFinite(box.height) && box.height >= 1, `height was ${box.height} for ${input}`);
	}
});

test("a non-image is refused by code", async () => {
	for (const file of [null, undefined, {}, { type: "text/plain" }, { type: "" }]) {
		await assert.rejects(() => prepareImage(file), /not-an-image/);
	}
});

test("an oversized source is refused before it is decoded", async () => {
	// The point is that no decoder is ever invoked: reading a 40MB file into
	// memory to then reject it is the failure mode being avoided.
	let decoded = 0;
	await assert.rejects(
		() =>
			prepareImage(
				{ type: "image/jpeg", size: MAX_INPUT_BYTES + 1 },
				{
					createImageBitmapImpl: () => {
						decoded += 1;
						return createBitmap(100, 100);
					}
				}
			),
		/too-large/
	);
	assert.equal(decoded, 0, "the file was decoded despite being over the limit");
});

test("a bitmap that reports no size is reported as a decode failure", async () => {
	const { documentImpl } = createCanvasDouble();
	await assert.rejects(
		() => prepareImage({ type: "image/jpeg" }, { createImageBitmapImpl: () => createBitmap(0, 0), documentImpl }),
		/decode-failed/
	);
});

test("a JPEG is encoded as JPEG at the downscaled size", async () => {
	const { documentImpl, canvas, draws } = createCanvasDouble({ sizeFor: () => 1000 });
	const bitmap = createBitmap(5000, 2500);
	const result = await prepareImage(
		{ type: "image/jpeg", size: 1024 },
		{ createImageBitmapImpl: () => bitmap, documentImpl, maxEdge: 2560 }
	);
	assert.equal(result.format, "image/jpeg");
	assert.equal(result.width, 2560);
	assert.equal(result.height, 1280);
	assert.equal(result.attempts, 1);
	assert.equal(result.bytes, result.dataUrl.length);
	assert.ok(result.dataUrl.startsWith("data:image/jpeg;base64,"));
	// And the canvas was actually sized and drawn into.
	assert.deepEqual(draws[0], { w: 2560, h: 1280 });
	assert.equal(canvas.box.width, 2560);
	// The decoded bitmap must be released even on the happy path.
	assert.equal(bitmap.closed, true, "the decoded bitmap was not closed");
});

test("a PNG keeps its alpha channel", async () => {
	const { documentImpl } = createCanvasDouble({ sizeFor: () => 1000 });
	const result = await prepareImage(
		{ type: "image/png" },
		{ createImageBitmapImpl: () => createBitmap(3000, 3000), documentImpl, maxEdge: 2560 }
	);
	assert.equal(result.format, "image/png");
	assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
});

test("a picture that does not fit is shrunk and thinned until it does", async () => {
	// The retry loop is the safety net for a huge source. Sizes here are chosen
	// so the first three attempts are over budget and the fourth is not.
	const budget = 4000;
	let call = 0;
	const sizes = [20000, 16000, 12000, 2000];
	const { documentImpl, canvas } = createCanvasDouble({ sizeFor: () => sizes[Math.min(call++, sizes.length - 1)] });
	const result = await prepareImage(
		{ type: "image/jpeg" },
		{ createImageBitmapImpl: () => createBitmap(6000, 4000), documentImpl, maxEdge: 2560, maxChars: budget }
	);
	assert.ok(result.dataUrl.length <= budget, `the result was ${result.dataUrl.length} characters`);
	assert.equal(result.attempts, 4, `gave up after ${result.attempts} attempts`);
	// Shrinking comes first because it costs resolution once, while compressing
	// costs it on every pixel.
	assert.ok(canvas.box.width < 2560, "the encoder never reduced the resolution");
});

test("a picture that cannot be made to fit reports still-too-large", async () => {
	const { documentImpl } = createCanvasDouble({ sizeFor: () => 10 * 1024 * 1024 });
	await assert.rejects(
		() =>
			prepareImage(
				{ type: "image/jpeg" },
				{ createImageBitmapImpl: () => createBitmap(6000, 4000), documentImpl, maxChars: 4096 }
			),
		/still-too-large/
	);
});

test("the bitmap is released even when the encode fails", async () => {
	// A leaked ImageBitmap holds decoded pixels — several megabytes per picture,
	// for a panel a user might open and close repeatedly.
	const bitmap = createBitmap(6000, 4000);
	const { documentImpl } = createCanvasDouble({ sizeFor: () => 10 * 1024 * 1024 });
	await assert.rejects(
		() => prepareImage({ type: "image/jpeg" }, { createImageBitmapImpl: () => bitmap, documentImpl, maxChars: 4096 })
	);
	assert.equal(bitmap.closed, true, "the decoded bitmap leaked");
});

test("a decode that only supports the element path still works", async () => {
	// `createImageBitmap` with an options bag is not universal; the fallback goes
	// through `URL.createObjectURL` and an `Image` element.
	const originalImage = globalThis.Image;
	const originalUrl = globalThis.URL;
	const created = [];
	globalThis.URL = {
		createObjectURL: () => "blob:fake",
		revokeObjectURL: () => {
			created.push("revoked");
		}
	};
	globalThis.Image = class {
		set src(value) {
			this._src = value;
			queueMicrotask(() => this.onload());
		}
		get src() {
			return this._src;
		}
		constructor() {
			this.width = 1200;
			this.height = 800;
			this.onload = null;
			this.onerror = null;
		}
	};
	try {
		const { documentImpl } = createCanvasDouble({ sizeFor: () => 500 });
		const result = await prepareImage({ type: "image/jpeg" }, { createImageBitmapImpl: null, documentImpl });
		assert.equal(result.width, 1200);
		assert.equal(result.height, 800);
		assert.deepEqual(created, ["revoked"], "the object URL was leaked");
	} finally {
		globalThis.Image = originalImage;
		globalThis.URL = originalUrl;
	}
});

test("a broken element-path decode reports decode-failed", async () => {
	const originalImage = globalThis.Image;
	const originalUrl = globalThis.URL;
	globalThis.URL = { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} };
	globalThis.Image = class {
		set src(value) {
			this._src = value;
			queueMicrotask(() => this.onerror());
		}
		get src() {
			return this._src;
		}
		constructor() {
			this.onload = null;
			this.onerror = null;
		}
	};
	try {
		await assert.rejects(
			() => prepareImage({ type: "image/jpeg" }, { createImageBitmapImpl: null, documentImpl: null }),
			/decode-failed/
		);
	} finally {
		globalThis.Image = originalImage;
		globalThis.URL = originalUrl;
	}
});

test("no canvas available is reported rather than thrown as a type error", async () => {
	await assert.rejects(
		() => prepareImage({ type: "image/jpeg" }, { createImageBitmapImpl: () => createBitmap(10, 10), documentImpl: null }),
		/no-canvas/
	);
	await assert.rejects(
		() =>
			prepareImage(
				{ type: "image/jpeg" },
				{ createImageBitmapImpl: () => createBitmap(10, 10), documentImpl: { createElement: () => ({}) } }
			),
		/no-canvas/
	);
	await assert.rejects(
		() =>
			prepareImage(
				{ type: "image/jpeg" },
				{
					createImageBitmapImpl: () => createBitmap(10, 10),
					documentImpl: { createElement: () => ({ getContext: () => null }) }
				}
			),
		/no-canvas/
	);
});

test("the defaults leave room for a real photograph", () => {
	assert.ok(DEFAULT_MAX_EDGE >= 1920, "the downscale target is too small for a hidpi display");
	assert.ok(MAX_INPUT_BYTES >= 8 * 1024 * 1024, "the input ceiling would reject a normal phone photo");
});

// ── the luminance measurement ─────────────────────────────────────────────────
//
// This is what turns the wash for an imported photo from a constant into a
// measurement, so it is the one part of the intake path whose *value* matters
// rather than its shape. The tests below pin the value, the fallback, and the
// fact that measuring never costs the encoder anything.

test("sampleLuminance reads the picture's brightness off a small square", () => {
	const square = LUMINANCE_SAMPLE_EDGE * LUMINANCE_SAMPLE_EDGE;
	const { documentImpl, canvases } = createCanvasDouble({ pixelsFor: () => flatPixels(square, 255, 255, 255) });
	const value = sampleLuminance({ width: 4000, height: 3000 }, documentImpl, LUMINANCE_SAMPLE_EDGE);
	assert.equal(value, 1, "a white picture did not measure as fully bright");
	// Exactly one measuring canvas, and it was drawn into at the sample size.
	assert.equal(canvases.length, 1, "measuring allocated more than one canvas");
	assert.deepEqual(canvases[0].draws, [{ w: LUMINANCE_SAMPLE_EDGE, h: LUMINANCE_SAMPLE_EDGE }]);
});

test("sampleLuminance reports unmeasurable rather than guessing", () => {
	// `pixelsFor` defaults to null, so `getImageData` throws — which is what a
	// tainted canvas does for a cross-origin picture.
	const { documentImpl } = createCanvasDouble({});
	assert.equal(sampleLuminance({ width: 100, height: 100 }, documentImpl, LUMINANCE_SAMPLE_EDGE), null);
	assert.equal(sampleLuminance({ width: 100, height: 100 }, null, LUMINANCE_SAMPLE_EDGE), null);
	assert.equal(sampleLuminance({ width: 100, height: 100 }, { }, LUMINANCE_SAMPLE_EDGE), null);
});

test("a fully transparent picture is never counted as black", () => {
	// A cut-out PNG's empty area carries no light. Counting it as black would
	// drag the estimate to zero, which is the one value that switches the
	// readability floor off entirely — so the answer must be the neutral
	// fallback, never `0`.
	const square = LUMINANCE_SAMPLE_EDGE * LUMINANCE_SAMPLE_EDGE;
	const { documentImpl } = createCanvasDouble({ pixelsFor: () => flatPixels(square, 0, 0, 0, 0) });
	const value = sampleLuminance({ width: 10, height: 10 }, documentImpl, LUMINANCE_SAMPLE_EDGE);
	assert.equal(value, NEUTRAL_LUMINANCE);
	assert.notEqual(value, 0, "transparent pixels were read as black");
});

test("a transparent picture that still has visible pixels measures those pixels", () => {
	// The realistic case: a cut-out subject on a transparent background. Half the
	// samples are empty and must not vote.
	const square = LUMINANCE_SAMPLE_EDGE * LUMINANCE_SAMPLE_EDGE;
	const data = new Uint8Array(square * 4);
	for (let i = 0; i < square; i += 1) {
		const visible = i % 2 === 0;
		data[i * 4] = 255;
		data[i * 4 + 1] = 255;
		data[i * 4 + 2] = 255;
		data[i * 4 + 3] = visible ? 255 : 0;
	}
	const { documentImpl } = createCanvasDouble({ pixelsFor: () => data });
	assert.equal(sampleLuminance({ width: 10, height: 10 }, documentImpl, LUMINANCE_SAMPLE_EDGE), 1);
});

test("prepareImage reports the measured luminance, and never invents one", async () => {
	const square = LUMINANCE_SAMPLE_EDGE * LUMINANCE_SAMPLE_EDGE;
	const bright = createCanvasDouble({ sizeFor: () => 500, pixelsFor: () => flatPixels(square, 255, 255, 255) });
	const measured = await prepareImage(
		{ type: "image/jpeg" },
		{ createImageBitmapImpl: () => createBitmap(800, 600), documentImpl: bright.documentImpl }
	);
	assert.equal(measured.luminance, 1, "the measurement did not reach the result");

	const blind = createCanvasDouble({ sizeFor: () => 500 });
	const guessed = await prepareImage(
		{ type: "image/jpeg" },
		{ createImageBitmapImpl: () => createBitmap(800, 600), documentImpl: blind.documentImpl }
	);
	assert.equal(guessed.luminance, null, "an unmeasurable picture produced a number anyway");
});

test("measuring draws into its own canvas, never the encoder's", async () => {
	// The failure this guards against is subtle and silent: if the measuring
	// canvas were the encoder's, sizing it to 64x64 would leave the encoder
	// writing a 64-pixel-wide wallpaper, and its draw would appear in the
	// encoder's history as if it were an encode.
	const square = LUMINANCE_SAMPLE_EDGE * LUMINANCE_SAMPLE_EDGE;
	const { documentImpl, canvases, canvas, draws } = createCanvasDouble({
		sizeFor: () => 500,
		pixelsFor: () => flatPixels(square, 128, 128, 128)
	});
	const result = await prepareImage(
		{ type: "image/jpeg" },
		{ createImageBitmapImpl: () => createBitmap(1200, 900), documentImpl, maxEdge: 1000 }
	);
	assert.equal(canvases.length, 2, "expected one encoder canvas and one measuring canvas");
	assert.equal(canvas.box.width, 1000, "the measuring canvas resized the encoder's");
	assert.deepEqual(draws, [{ w: 1000, h: 750 }], "the measurement leaked into the encoder's draws");
	assert.equal(result.width, 1000);
	assert.equal(result.height, 750);
	assert.equal(result.luminance, 0.216, "mid-grey should measure near the WCAG mid-grey value");
});
