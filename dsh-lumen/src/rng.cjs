"use strict";
/**
 * Deterministic pseudo-randomness.
 *
 * The built-in wallpapers are generated, and a generator that produced a
 * different picture on every reload would be unusable: you could not "keep
 * this one", the rotation would not be reproducible between two tabs, and no
 * test could pin the output. So every wallpaper is a pure function of
 * `(recipeId, seed)` — same inputs, same pixels, forever.
 *
 * mulberry32 is chosen over Math.random because it is 5 lines, has no state
 * beyond one 32-bit integer, produces a full 2^32 period, and passes the
 * smallcrush-scale statistics that matter for scattering light blobs (no
 * visible lattice at the sample counts used here).
 */

/** FNV-1a over UTF-16 code units — string seed in, 32-bit unsigned out. */
function hashSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		// Multiply by the FNV prime (16777619) without losing precision to
		// float rounding: the standard shift/add expansion.
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}

/**
 * A seeded stream.
 * @param {string|number} seed
 */
function createRng(seed) {
	let state = (typeof seed === "number" ? seed >>> 0 : hashSeed(String(seed))) || 0x9e3779b9;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		/** Uniform in [0, 1). */
		float: next,
		/** Uniform in [min, max). */
		range: (min, max) => min + next() * (max - min),
		/** Integer in [min, max] inclusive. */
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		/** True with probability p. */
		chance: (p) => next() < p,
		/** Uniform choice; `undefined` for an empty list. */
		pick: (list) => (list.length === 0 ? undefined : list[Math.floor(next() * list.length)]),
		/**
		 * A fresh random seed derived from this stream — used by the "shake"
		 * button so a new variant is still reproducible from its printed seed.
		 */
		nextSeed: () => `s${Math.floor(next() * 0xffffffff).toString(36)}`
	};
}

/**
 * Fisher–Yates over a copy. Used by the rotation scheduler's `shuffle` order:
 * a shuffled permutation must not repeat an entry until it has been through
 * the whole list, which `pick a random index each tick` cannot promise.
 */
function shuffled(list, rng) {
	const out = list.slice();
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = rng.int(0, i);
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

module.exports = { hashSeed, createRng, shuffled };
