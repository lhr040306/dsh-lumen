"use strict";
/**
 * Seeded randomness.
 *
 * The load-bearing property is determinism: a wallpaper must be the same
 * picture after a reload, in another tab, and on another machine, or nothing
 * else in this plugin (restoring a rotation, sharing a seed, pinning a test)
 * works. The distribution checks are only here to catch a stream that has
 * collapsed into a constant.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { hashSeed, createRng, shuffled } = require("../src/rng.cjs");

/** A Kolmogorov-style bucket check with generous slack — this catches collapse, not bias. */
function bucketSpread(rng, buckets, draws) {
	const counts = new Array(buckets).fill(0);
	for (let i = 0; i < draws; i += 1) {
		const value = rng.float();
		assert.ok(value >= 0 && value < 1, `float out of range: ${value}`);
		counts[Math.floor(value * buckets)] += 1;
	}
	const expected = draws / buckets;
	return counts.map((c) => Math.abs(c - expected) / expected);
}

test("hashSeed is stable and avalanche-y for near-identical inputs", () => {
	assert.equal(hashSeed("drift:seed-1"), hashSeed("drift:seed-1"));
	assert.notEqual(hashSeed("drift:seed-1"), hashSeed("drift:seed-2"));
	// Sequential suffixes must not produce sequential outputs.
	const values = Array.from({ length: 64 }, (_, i) => hashSeed(`lumen-order:${i}`));
	assert.equal(new Set(values).size, 64, "hash collided across 64 sequential seeds");
	const deltas = values.slice(1).map((v, i) => Math.abs(v - values[i]));
	const tiny = deltas.filter((d) => d < 1000).length;
	assert.ok(tiny <= 2, `${tiny} of 63 adjacent seeds hashed almost identically`);
});

test("a stream is reproducible from its seed", () => {
	const a = createRng("recipe:demo");
	const b = createRng("recipe:demo");
	for (let i = 0; i < 200; i += 1) assert.equal(a.float(), b.float());
});

test("different seeds produce different streams", () => {
	const a = createRng("one");
	const b = createRng("two");
	const same = Array.from({ length: 32 }, () => (a.float() === b.float() ? 1 : 0)).reduce((x, y) => x + y, 0);
	assert.ok(same < 3, `${same} of 32 draws collided across two seeds`);
});

test("an empty seed still produces a usable stream", () => {
	const rng = createRng("");
	const values = Array.from({ length: 64 }, () => rng.float());
	assert.ok(values.some((v) => v > 0.1 && v < 0.9), "empty seed degenerated");
});

test("float is uniformly spread across its range", () => {
	const deviation = bucketSpread(createRng("uniform"), 10, 20000);
	for (const d of deviation) assert.ok(d < 0.12, `bucket deviated by ${(d * 100).toFixed(1)}%`);
});

test("int is inclusive of both ends and never escapes them", () => {
	const rng = createRng("int");
	const seen = new Set();
	for (let i = 0; i < 8000; i += 1) {
		const value = rng.int(2, 5);
		assert.ok(Number.isInteger(value), "int returned a non-integer");
		assert.ok(value >= 2 && value <= 5, `int escaped its range: ${value}`);
		seen.add(value);
	}
	assert.equal(seen.size, 4, "int never produced one of its endpoints");
});

test("int of a single value is a constant", () => {
	const rng = createRng("single");
	for (let i = 0; i < 50; i += 1) assert.equal(rng.int(7, 7), 7);
});

test("range respects its bounds", () => {
	const rng = createRng("range");
	for (let i = 0; i < 2000; i += 1) {
		const value = rng.range(-3, 9);
		assert.ok(value >= -3 && value < 9, `range escaped: ${value}`);
	}
});

test("pick covers every element and survives an empty list", () => {
	const rng = createRng("pick");
	const list = ["a", "b", "c"];
	const seen = new Set(Array.from({ length: 500 }, () => rng.pick(list)));
	assert.equal(seen.size, 3);
	assert.equal(rng.pick([]), undefined);
});

test("shuffled returns a permutation, leaves the input untouched, and is seeded", () => {
	const input = [1, 2, 3, 4, 5, 6, 7, 8];
	const a = shuffled(input, createRng("shuffle"));
	const b = shuffled(input, createRng("shuffle"));
	assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8], "shuffled mutated its input");
	assert.deepEqual(a, b, "shuffled is not reproducible");
	assert.deepEqual([...a].sort((x, y) => x - y), input, "shuffled is not a permutation");
});

test("nextSeed produces distinct, printable seeds", () => {
	const rng = createRng("seeds");
	const seeds = new Set(Array.from({ length: 200 }, () => rng.nextSeed()));
	assert.ok(seeds.size > 190, `only ${seeds.size} distinct seeds from 200 draws`);
	for (const seed of seeds) assert.ok(/^s[0-9a-z]+$/.test(seed), `odd seed: ${seed}`);
});
