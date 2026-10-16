"use strict";
/**
 * Local images: decode, downscale, re-encode, and prove the result fits.
 *
 * A user picks a 12-megapixel phone photo and expects it to become their
 * wallpaper. Two things have to happen before it can be one, and both are about
 * *survival* rather than quality:
 *
 *   1. **It must fit.** A 12MP JPEG is 3-8MB; base64 adds a third; the durable
 *      state file and the browser's storage both have limits. Left alone, the
 *      write fails and the user is told nothing. So the picture is downscaled
 *      to a sane long edge and re-encoded, and if it *still* does not fit the
 *      encoder steps quality down until it does — reporting the final size.
 *   2. **It must decode.** Phone photos carry EXIF orientation, and a picture
 *      drawn without honouring it lands sideways. `createImageBitmap` with
 *      `imageOrientation: "from-image"` handles that in the browser rather than
 *      in a parser here.
 *
 * Alpha is preserved when the source had it (PNG), because a cut-out
 * photograph on a wallpaper is not an edge case anyone expects to lose.
 *
 * A third thing is measured rather than enforced: **how bright the picture is**.
 * The wash that keeps DSH's text readable is solved against the wallpaper's
 * relative luminance, and for a raster picture that value is otherwise
 * unknowable — see `sampleLuminance`.
 */

const { pixelLuminanceEstimate } = require("./color.cjs");

/** Longest edge kept, px. Beyond this a wallpaper gains nothing on any display. */
const DEFAULT_MAX_EDGE = 2560;
/** JPEG quality for the first attempt. */
const DEFAULT_QUALITY = 0.86;
/** Largest source file accepted, bytes. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
/** Largest encoded result accepted, characters of data URL. */
const DEFAULT_MAX_CHARS = 6 * 1024 * 1024;
/** How many times the encoder may step down before giving up. */
const MAX_ATTEMPTS = 6;
/** Edge of the square the picture is sampled into for its luminance estimate. */
const LUMINANCE_SAMPLE_EDGE = 64;

/**
 * Scale a `w x h` box down so its longest edge is at most `maxEdge`,
 * never enlarging. Pure, so the arithmetic is testable without a canvas.
 * @returns {{width: number, height: number, scale: number}}
 */
function fitWithin(width, height, maxEdge) {
	const w = Math.max(1, Math.floor(Number(width) || 1));
	const h = Math.max(1, Math.floor(Number(height) || 1));
	const limit = Math.max(1, Math.floor(Number(maxEdge) || 1));
	const longest = Math.max(w, h);
	if (longest <= limit) return { width: w, height: h, scale: 1 };
	const scale = limit / longest;
	return {
		width: Math.max(1, Math.round(w * scale)),
		height: Math.max(1, Math.round(h * scale)),
		scale
	};
}

/**
 * Decode a `File`/`Blob` into something drawable, honouring EXIF orientation.
 * `factory` is `createImageBitmap` when the engine has it, or `null` to force
 * the `<img>` fallback. It is passed in rather than read from the global scope
 * so the fallback path is reachable in a test.
 */
async function decode(file, factory) {
	if (typeof factory === "function") {
		try {
			return await factory(file, { imageOrientation: "from-image" });
		} catch {
			// Older engines reject the options bag; fall through to the element path.
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const image = await new Promise((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("decode-failed"));
			el.src = url;
		});
		return image;
	} finally {
		// Revoking immediately is safe: the decoded element keeps its own copy.
		URL.revokeObjectURL(url);
	}
}

/** Source dimensions of a drawable decoded by {@link decode}. */
function sizeOf(decoded) {
	const width = decoded.width || (decoded.naturalWidth || 0);
	const height = decoded.height || (decoded.naturalHeight || 0);
	return { width, height };
}

/**
 * Measure how bright the picture is, on a small square sample.
 *
 * WHY THIS RUNS HERE AT ALL. The wash that keeps text legible is solved against
 * the wallpaper's WCAG relative luminance, and for a photograph that number
 * does not exist until something decodes it. `engine.itemToBackground` has to
 * fall back to a constant (0.42, erring bright) for every raster picture,
 * because the render path is synchronous and has no pixels to look at. This
 * module is the one place that already holds the decoded bitmap, so this is the
 * one place where the constant can be replaced by a measurement — and it costs
 * one extra 64x64 draw.
 *
 * WHY A SQUARE SAMPLE. Squashing to a square still covers every source cell
 * exactly once, so each sample stands for an equal area of the original. That
 * is what makes a rank-based estimate mean anything. Preserving the aspect
 * ratio would sample the same areas and cost more arithmetic for nothing —
 * the estimate is rank-based, not averaged, so pixel geometry does not enter.
 *
 * WHY IT DOES NOT THROW. A picture that cannot be measured is still a perfectly
 * good wallpaper; only the readability floor gets less precise. So every
 * failure — no canvas, no `getImageData`, a tainted canvas, a decode that
 * yields nothing — returns `null`, and the caller keeps its constant. A
 * measurement that silently degrades into a guess is worse than no measurement,
 * which is why this never invents a number.
 *
 * @returns {number|null} relative luminance 0..1, or `null` if unmeasurable
 */
function sampleLuminance(decoded, doc, edge) {
	const size = Math.max(1, Math.floor(Number(edge) || LUMINANCE_SAMPLE_EDGE));
	if (doc === null || doc === undefined || typeof doc.createElement !== "function") return null;
	try {
		const canvas = doc.createElement("canvas");
		if (canvas === null || canvas === undefined || typeof canvas.getContext !== "function") return null;
		const context = canvas.getContext("2d");
		if (context === null || context === undefined || typeof context.getImageData !== "function") return null;
		canvas.width = size;
		canvas.height = size;
		if (typeof context.clearRect === "function") context.clearRect(0, 0, size, size);
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(decoded, 0, 0, size, size);
		const image = context.getImageData(0, 0, size, size);
		if (image === null || image === undefined || image.data === null || image.data === undefined) return null;
		// Rounded at the source so the number this function reports and the number
		// `state.normalizeLuminance` persists are the same value. Three decimals is
		// far below a display step and keeps the stored field small.
		const measured = pixelLuminanceEstimate(image.data);
		return Math.round(measured * 1000) / 1000;
	} catch {
		// A tainted canvas is the expected failure for a cross-origin source; the
		// rest are defence. Either way the answer is "unmeasured", not a number.
		return null;
	}
}

/**
 * Turn a picked file into a wallpaper-ready data URL.
 *
 * @param {File|Blob} file
 * @param {object} [options]
 * @param {Function|null} [options.createImageBitmapImpl] injected decoder
 * @param {Document|null} [options.documentImpl] injected document for the canvas
 * @param {number} [options.luminanceEdge] sample edge for the luminance estimate
 * @returns {Promise<{dataUrl: string, width: number, height: number, bytes: number, attempts: number, format: string, luminance: number|null}>}
 * @throws {Error} with `message` in { not-an-image, too-large, decode-failed,
 *   still-too-large, no-canvas } — callers map these onto user-facing text.
 */
async function prepareImage(file, options) {
	const opts = options || {};
	if (!file || typeof file.type !== "string" || file.type.indexOf("image/") !== 0) {
		throw new Error("not-an-image");
	}
	if (typeof file.size === "number" && file.size > MAX_INPUT_BYTES) {
		throw new Error("too-large");
	}
	const maxEdge = Number(opts.maxEdge) || DEFAULT_MAX_EDGE;
	const maxChars = Number(opts.maxChars) || DEFAULT_MAX_CHARS;
	const factory = Object.prototype.hasOwnProperty.call(opts, "createImageBitmapImpl")
		? opts.createImageBitmapImpl
		: typeof createImageBitmap === "function"
			? createImageBitmap
			: null;
	const decoded = await decode(file, factory);
	const { width, height } = sizeOf(decoded);
	if (width === 0 || height === 0) throw new Error("decode-failed");

	// PNG keeps its alpha; everything else becomes JPEG, which is 5-10x smaller
	// for photographic content.
	const keepAlpha = file.type === "image/png" || file.type === "image/webp";
	const format = keepAlpha ? "image/png" : "image/jpeg";

	const doc = Object.prototype.hasOwnProperty.call(opts, "documentImpl")
		? opts.documentImpl
		: typeof document !== "undefined"
			? document
			: null;
	if (doc === null || typeof doc.createElement !== "function") throw new Error("no-canvas");
	const canvas = doc.createElement("canvas");
	if (typeof canvas.getContext !== "function") throw new Error("no-canvas");
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("no-canvas");

	// Measured from the *source*, before any re-encoding: brightness is a
	// property of the picture the user chose, not of the downscale we happen to
	// apply. Doing it once up front also means the value is available whichever
	// pass of the loop ends up fitting.
	const luminance = sampleLuminance(decoded, doc, opts.luminanceEdge);

	let edge = maxEdge;
	let quality = Number(opts.quality) || DEFAULT_QUALITY;
	let last = null;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const box = fitWithin(width, height, edge);
		canvas.width = box.width;
		canvas.height = box.height;
		context.clearRect(0, 0, box.width, box.height);
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(decoded, 0, 0, box.width, box.height);
		const dataUrl = keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);
		last = { dataUrl, width: box.width, height: box.height, attempts: attempt + 1, format };
		if (dataUrl.length <= maxChars) {
			if (typeof decoded.close === "function") decoded.close();
			return { ...last, bytes: dataUrl.length, luminance };
		}
		// Shrink first, then thin the quality: shrinking costs resolution once,
		// compressing costs it on every pixel.
		if (attempt % 2 === 0) edge = Math.round(edge * 0.78);
		else quality = Math.max(0.55, quality - 0.1);
	}
	if (typeof decoded.close === "function") decoded.close();
	throw new Error("still-too-large");
}

module.exports = {
	prepareImage,
	fitWithin,
	sampleLuminance,
	DEFAULT_MAX_EDGE,
	DEFAULT_QUALITY,
	DEFAULT_MAX_CHARS,
	MAX_INPUT_BYTES,
	LUMINANCE_SAMPLE_EDGE
};
