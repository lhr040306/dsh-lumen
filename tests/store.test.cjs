"use strict";
/**
 * Persistence.
 *
 * The behaviours worth pinning are the ones that only show up in production:
 * a restart landing on a different origin (the seed), a host API that is not
 * there (degrade, do not fail), and two writers sharing one file (merge, do not
 * clobber).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore } = require("../src/store.cjs");
const { createStorage } = require("./helpers/minidom.cjs");
const state = require("../src/state.cjs");

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

/**
 * A stand-in for the host's fenced API, implementing the same merge contract:
 * a string sets, `null` deletes, an absent key is left alone.
 */
function createHostFile() {
	const file = new Map();
	return {
		file,
		fetchImpl: async (url, init) => {
			let body = null;
			try {
				body = JSON.parse(init.body);
			} catch {
				body = null;
			}
			if (body === null || typeof body.method !== "string") {
				return { ok: false, status: 400, json: async () => ({ ok: false, error: { code: "bad-request" } }) };
			}
			if (body.method === "get") {
				return { ok: true, status: 200, json: async () => ({ ok: true, value: Object.fromEntries(file) }) };
			}
			if (body.method === "set") {
				for (const [key, value] of Object.entries(body.patch || {})) {
					if (value === null) file.delete(key);
					else file.set(key, value);
				}
				return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) };
			}
			return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: "not-found" } }) };
		}
	};
}

/** A store wired to a memory host file and a memory localStorage. */
function makeStore(host, storage) {
	return createStore({
		apiPath: "/lumen/api",
		fetchImpl: host.fetchImpl,
		storage: storage || createStorage()
	});
}

test("a first run with nothing stored yields renderable defaults", async () => {
	const host = createHostFile();
	const store = makeStore(host);
	const loaded = await store.load();
	assert.equal(loaded.mode, "single");
	assert.equal(loaded.playlist.length, 0);
	assert.equal(store.getHealth().hostAvailable, true);
	store.dispose();
});

test("a change reaches the host file and survives a restart", async () => {
	const host = createHostFile();
	const storage = createStorage();
	const first = makeStore(host, storage);
	await first.load();
	first.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "dune", seed: "s7" };
		draft.wash = { ...draft.wash, opacity: 0.55, blur: 9 };
		return draft;
	});
	await first.flush();
	first.dispose();

	assert.ok(host.file.has("single"), "the wallpaper never reached the host file");
	assert.ok(host.file.has("wash"), "the wash never reached the host file");
	assert.ok(host.file.has("schema"), "the document was never stamped");
	// A restart on a different origin: same host file, a fresh (empty) localStorage.
	const second = makeStore(host, createStorage());
	const loaded = await second.load();
	assert.equal(loaded.single.ref, "dune");
	assert.equal(loaded.single.seed, "s7");
	assert.equal(loaded.wash.opacity, 0.55);
	assert.equal(loaded.wash.blur, 9);
	second.dispose();
});

test("a save never deletes a key this build does not model", async () => {
	const host = createHostFile();
	// Several writers share one durable file. The host half adds `splash.media`
	// when a splash is uploaded, another window may have set something this build
	// has never heard of, and a newer build may have added keys outright. READING
	// already degrades to "an unknown key we ignore" — the flat string map exists
	// for exactly that. WRITING has to degrade the same way. A save that treats
	// "I do not recognise this key" as "this key should not exist" makes the
	// upgrade path lossy in the worst direction: the user changes their wallpaper
	// and their splash disappears with it.
	host.file.set("splash.media", "media-abc-01234567.png");
	host.file.set("some-future-preference", "kept");
	const store = makeStore(host);
	await store.load();
	store.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.5 };
		return draft;
	});
	await store.flush();
	assert.equal(host.file.get("splash.media"), "media-abc-01234567.png", "a save deleted the splash the host had stored");
	assert.equal(host.file.get("some-future-preference"), "kept", "a save deleted a key written by a newer build");
	store.dispose();
});

test("a payload key the browser half no longer owns is still deleted", async () => {
	const host = createHostFile();
	// The other half of the same rule: keys this build DOES model must still be
	// cleaned up, or removing a playlist entry leaves its picture on disk forever.
	const store = makeStore(host);
	await store.load();
	store.update((draft) => {
		draft.single = { ...draft.single, kind: "image", ref: TINY_PNG, seed: "default" };
		return draft;
	});
	await store.flush();
	const payloadKeys = [...host.file.keys()].filter((key) => key.startsWith("blob:"));
	assert.equal(payloadKeys.length, 1, "the new picture was never stored");
	store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "dune", seed: "default" };
		return draft;
	});
	await store.flush();
	assert.deepEqual([...host.file.keys()].filter((key) => key.startsWith("blob:")), [], "the orphaned payload must be deleted");
	store.dispose();
});

test("the local seed paints before the host answers, and is adopted when the host is empty", async () => {
	const host = createHostFile();
	const storage = createStorage();
	const first = makeStore(host, storage);
	await first.load();
	first.update((draft) => {
		draft.single = { ...draft.single, ref: "aurora", seed: "seeded" };
		return draft;
	});
	await first.flush();
	first.dispose();
	// Simulate the OS-assigned-port problem: a new origin (fresh storage) but a
	// host file that was lost or never written.
	const freshHost = createHostFile();
	const second = makeStore(freshHost, storage);
	const loaded = await second.load();
	assert.equal(loaded.single.ref, "aurora", "the seed was not read");
	// And the seed was pushed into the empty host file so the next launch is not empty.
	await second.flush();
	assert.ok(freshHost.file.has("single"), "the rescued seed never reached the empty host file");
	second.dispose();
});

test("removing a playlist entry deletes its payload from the host", async () => {
	const host = createHostFile();
	const store = makeStore(host);
	await store.load();
	store.update((draft) => {
		const item = state.createItem("image", TINY_PNG);
		item.id = "keep1";
		const other = state.createItem("image", TINY_PNG);
		other.id = "drop1";
		draft.playlist = [item, other];
		draft.mode = "rotation";
		return draft;
	});
	await store.flush();
	assert.ok(host.file.has("blob:drop1"), "the payload never reached the host");

	store.update((draft) => {
		draft.playlist = draft.playlist.filter((item) => item.id !== "drop1");
		return draft;
	});
	await store.flush();
	assert.equal(host.file.has("blob:drop1"), false, "the removed payload was left behind");
	assert.ok(host.file.has("blob:keep1"), "the surviving payload was deleted too");
	store.dispose();
});

test("two writers changing different keys do not clobber each other", async () => {
	const host = createHostFile();
	const storage = createStorage();
	const a = makeStore(host, storage);
	const b = makeStore(host, storage);
	await a.load();
	await b.load();

	a.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.42 };
		return draft;
	});
	await a.flush();
	// `b` still holds the pre-change copy, but it only writes what it changed.
	b.update((draft) => {
		draft.single = { ...draft.single, ref: "dune" };
		return draft;
	});
	await b.flush();

	const c = makeStore(host, createStorage());
	const merged = await c.load();
	assert.equal(merged.wash.opacity, 0.42, "a's wash was lost");
	assert.equal(merged.single.ref, "dune", "b's wallpaper was lost");
	a.dispose();
	b.dispose();
	c.dispose();
});

test("a missing host API degrades to browser-only instead of failing", async () => {
	const store = createStore({
		apiPath: "/lumen/api",
		storage: createStorage(),
		fetchImpl: async () => {
			throw new Error("ECONNREFUSED");
		}
	});
	const loaded = await store.load();
	assert.equal(loaded.mode, "single");
	const health = store.getHealth();
	assert.equal(health.hostAvailable, false);
	assert.equal(health.hostReason, "network");
	assert.equal(health.hasStorage, true);
	// Writes still work locally and must not throw.
	store.update((draft) => {
		draft.single = { ...draft.single, ref: "starfield" };
		return draft;
	});
	await store.flush();
	store.dispose();
});

test("no fetch implementation and no storage is survivable", async () => {
	const store = createStore({ apiPath: "/lumen/api", storage: null, fetchImpl: null });
	const loaded = await store.load();
	assert.equal(loaded.mode, "single");
	const health = store.getHealth();
	assert.equal(health.hostAvailable, false);
	assert.equal(health.hostReason, "no-fetch");
	assert.equal(health.hasStorage, false);
	store.dispose();
});

test("a malformed host answer is treated as unavailable, not as state", async () => {
	const store = createStore({
		apiPath: "/lumen/api",
		storage: createStorage(),
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })
	});
	const loaded = await store.load();
	assert.equal(store.getHealth().hostAvailable, false);
	assert.equal(store.getHealth().hostReason, "get-malformed");
	assert.equal(loaded.mode, "single");
	store.dispose();
});

test("a storage that refuses writes does not break the store", async () => {
	const hostile = {
		get length() {
			throw new Error("denied");
		},
		key() {
			throw new Error("denied");
		},
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
		removeItem() {
			throw new Error("denied");
		}
	};
	const store = createStore({ apiPath: "/lumen/api", storage: hostile, fetchImpl: null });
	const loaded = await store.load();
	assert.equal(loaded.mode, "single");
	assert.equal(store.getHealth().hasStorage, false, "an unusable storage must be reported as absent");
	store.update((draft) => {
		draft.single = { ...draft.single, ref: "dune" };
		return draft;
	});
	await store.flush();
	store.dispose();
});

test("subscribers are notified on change and released on dispose", async () => {
	const store = makeStore(createHostFile());
	await store.load();
	let calls = 0;
	const unsubscribe = store.subscribe(() => {
		calls += 1;
	});
	store.update((draft) => {
		draft.single = { ...draft.single, ref: "aurora" };
		return draft;
	});
	assert.ok(calls > 0, "a change did not notify");
	unsubscribe();
	const before = calls;
	store.update((draft) => {
		draft.single = { ...draft.single, ref: "aurora" };
		return draft;
	});
	assert.equal(calls, before, "unsubscribe did not take effect");
	store.dispose();
});

test("a throwing subscriber does not stop the others", async () => {
	const store = makeStore(createHostFile());
	await store.load();
	let reached = false;
	store.subscribe(() => {
		throw new Error("listener exploded");
	});
	store.subscribe(() => {
		reached = true;
	});
	store.update((draft) => {
		draft.single = { ...draft.single, ref: "dune" };
		return draft;
	});
	assert.equal(reached, true);
	store.dispose();
});

test("an oversized image seed is skipped without losing the rest", async () => {
	const storage = createStorage();
	// A storage that refuses any value over a small threshold.
	const limited = {
		...storage,
		setItem(key, value) {
			if (String(value).length > 400) throw new Error("QuotaExceededError");
			storage.setItem(key, value);
		}
	};
	const host = createHostFile();
	const store = makeStore(host, limited);
	await store.load();
	store.update((draft) => {
		const big = state.createItem("image", `data:image/png;base64,${"A".repeat(2000)}`);
		big.id = "big1";
		draft.playlist = [big, state.createItem("recipe", "mist")];
		draft.mode = "rotation";
		return draft;
	});
	await store.flush();
	assert.equal(store.getState().playlist.length, 2);
	// The durable copy still has the payload even though the seed could not.
	assert.ok(host.file.has("blob:big1"));
	store.dispose();
});
