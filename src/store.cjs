"use strict";
/**
 * Persistence: a synchronous local seed plus the durable host channel.
 *
 * THE PROBLEM THIS SOLVES, AND WHY IT TAKES TWO STORES
 *
 * `localStorage` is scoped per origin, and DSH Desktop binds its web server to
 * an OS-assigned port on every launch. The origin therefore changes on every
 * restart, and a plugin that keeps its state only in `localStorage` "forgets"
 * the user's wallpaper every time the app is reopened — the data is still in
 * the browser's leveldb, just filed under the previous port.
 *
 * So the authoritative copy lives in a file the host owns (`$DSH_HOME/lumen.json`,
 * reached through the fenced `/lumen/api` route), and `localStorage` is kept as
 * a *seed*: it is synchronous, so the very first paint after a reload is already
 * the right wallpaper instead of flashing the default for as long as the HTTP
 * round-trip takes. The host answer then replaces the seed.
 *
 * The seed stores the SAME flat map as the host, under a `dsh-lumen:` prefix.
 * Sharing one serialisation is what keeps the two tiers from drifting: if the
 * seed had its own format, a field added to one would silently be missing from
 * the other, and the mismatch would only show as a wrong first paint.
 *
 * WRITES CARRY INTENT, NOT THE WHOLE DOCUMENT
 *
 * The host API merges a patch: an absent key keeps its old value, an explicit
 * `null` deletes. This module therefore pushes only the fields the user (or the
 * rotation engine) actually changed, plus `null` for payload keys that
 * disappeared — a *touched* key that is no longer present must be deleted, or
 * removing a playlist entry would leave its image bytes on disk forever.
 *
 * Pushing the whole document instead would be simpler and wrong: two DSH
 * windows share one `$DSH_HOME/lumen.json`, so a window that only changed its
 * wallpaper would revert the other window's wash, tuning and schedule.
 */

const { toStore, fromStore, defaultState, normalizeState, blobKey, DOC_KEYS, SCHEMA_KEY } = require("./state.cjs");

/** Debounce window for pushing to the host, in ms. */
const PUSH_DEBOUNCE_MS = 400;
/** localStorage namespace for the seed mirror. */
const SEED_PREFIX = "dsh-lumen:";
/** Marker key holding the seed format version. */
const SEED_VERSION_KEY = "dsh-lumen:seed-version";
/** Seed format version — bump to invalidate seeds written by an older build. */
const SEED_VERSION = "1";

/** Preference keys, as a set, so payload keys can be told apart from them. */
const PREF_KEYS = new Set(DOC_KEYS);
/**
 * The key shape this half owns for picture payloads.
 *
 * Derived from `blobKey` rather than written out, so the builder and the
 * deletion check below cannot drift apart.
 */
const PAYLOAD_PREFIX = blobKey("");

/**
 * Structural equality, used only to notice which fields a mutator changed.
 *
 * Reference equality carries the common case: a mutator that leaves a field
 * alone leaves the same object in place, so an 8MB data URL is never compared
 * character by character unless the picture genuinely changed.
 */
function sameValue(a, b) {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
	}
	if (typeof a === "object") {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
	}
	return false;
}

/** A safe localStorage, or `null` when unavailable (private mode, disabled). */
function resolveStorage(candidate) {
	try {
		const store = candidate || (typeof window !== "undefined" ? window.localStorage : null);
		if (store === null || store === undefined) return null;
		// Probe: a store that exists but refuses writes (Safari private mode) is
		// worse than none, because writes would appear to succeed.
		const probe = "__dsh_lumen_probe__";
		store.setItem(probe, "1");
		store.removeItem(probe);
		return store;
	} catch {
		return null;
	}
}

/**
 * Create the persistence layer.
 *
 * @param {object} [options]
 * @param {string} [options.apiPath] host route, absolute on the current origin
 * @param {object} [options.storage] storage implementation; `null` means "none"
 * @param {(url: string, init: object) => Promise<object>} [options.fetchImpl] `null` means "no host channel"
 */
function createStore(options) {
	const opts = options || {};
	const apiPath = typeof opts.apiPath === "string" ? opts.apiPath : "/lumen/api";
	// An *absent* option means "use the ambient default"; an option explicitly
	// passed as `null` means "there is none". Without the distinction, a caller
	// asking for a host-less store on a runtime that has a global `fetch`
	// silently gets one, and the degradation path is never exercised.
	const storage = Object.prototype.hasOwnProperty.call(opts, "storage") && opts.storage === null ? null : resolveStorage(opts.storage);
	const fetchImpl = Object.prototype.hasOwnProperty.call(opts, "fetchImpl")
		? typeof opts.fetchImpl === "function"
			? opts.fetchImpl
			: null
		: typeof fetch === "function"
			? fetch.bind(globalThis)
			: null;

	let state = defaultState();
	let revision = 0;
	const listeners = new Set();
	/** Preference keys changed since the last successful push. */
	const touched = new Set();
	/** What the host is believed to hold, as a flat `key -> string` map. */
	let baseline = new Map();
	let pushTimer = null;
	let pushInFlight = null;
	let hostAvailable = true;
	let hostReason = null;
	let lastError = null;
	let disposed = false;

	/**
	 * Read the seed synchronously so the first paint is already correct.
	 * Returns a normalized state, or `null` when there is no usable seed.
	 */
	function readSeed() {
		if (storage === null) return null;
		try {
			if (storage.getItem(SEED_VERSION_KEY) !== SEED_VERSION) return null;
			const map = {};
			let stamped = false;
			for (let i = 0; i < storage.length; i += 1) {
				const key = storage.key(i);
				if (typeof key !== "string" || !key.startsWith(SEED_PREFIX)) continue;
				const bare = key.slice(SEED_PREFIX.length);
				if (bare.length === 0) continue;
				const value = storage.getItem(key);
				if (typeof value !== "string") continue;
				map[bare] = value;
				if (bare === SCHEMA_KEY) stamped = true;
			}
			// The schema stamp is written by every seed, so its absence means the
			// `dsh-lumen:` keys belong to some other feature, not to us.
			if (!stamped) return null;
			return fromStore(map);
		} catch {
			return null;
		}
	}

	/** Mirror the flat map into localStorage under the seed prefix. */
	function writeSeed(map) {
		if (storage === null) return;
		try {
			const keep = new Set([SEED_VERSION_KEY]);
			for (const key of Object.keys(map)) keep.add(SEED_PREFIX + key);
			for (const key of seedKeys()) {
				if (!keep.has(key)) storage.removeItem(key);
			}
			for (const [key, value] of Object.entries(map)) {
				// A single oversized image must not take the rest of the seed with
				// it. If it does not fit, skip the payload: the durable host copy
				// still has it, only the instant-paint seed is short a picture.
				try {
					storage.setItem(SEED_PREFIX + key, value);
				} catch {
					lastError = "seed-quota";
				}
			}
			storage.setItem(SEED_VERSION_KEY, SEED_VERSION);
		} catch {
			lastError = "seed-quota";
		}
	}

	/** Every `dsh-lumen:`-prefixed key currently in the seed store. */
	function seedKeys() {
		const keys = [];
		if (storage === null) return keys;
		try {
			for (let i = 0; i < storage.length; i += 1) {
				const key = storage.key(i);
				if (typeof key === "string" && key.startsWith(SEED_PREFIX)) keys.push(key);
			}
		} catch {
			return [];
		}
		return keys;
	}

	function notify() {
		revision += 1;
		const snapshot = { state, revision, hostAvailable, hostReason, lastError };
		for (const listener of Array.from(listeners)) {
			try {
				listener(snapshot);
			} catch (error) {
				// A broken listener must not stop the others from being told.
				try {
					console.warn("[dsh-lumen] listener failed:", error && error.message);
				} catch {}
			}
		}
	}

	/**
	 * Replace the in-memory state, recording which fields actually moved.
	 *
	 * `intent` is what decides the next patch, so it is tracked here rather than
	 * in `update`: every mutation in the plugin funnels through this method, and
	 * a mutation that slipped past the diff would be a change the user made that
	 * never reaches disk.
	 */
	function setState(next) {
		const normalized = normalizeState(next);
		for (const key of DOC_KEYS) {
			if (!sameValue(state[key], normalized[key])) touched.add(key);
		}
		state = normalized;
		notify();
		return state;
	}

	/** Apply a mutator to a copy of the state and commit it. */
	function update(mutator) {
		const draft = {
			...state,
			single: { ...state.single },
			playlist: state.playlist.slice(),
			remaining: state.remaining.slice(),
			wash: { ...state.wash },
			tuning: { ...state.tuning },
			schedule: { ...state.schedule }
		};
		const result = typeof mutator === "function" ? mutator(draft) : draft;
		return setState(result || draft);
	}

	/** Persist the current state. Debounced; safe to call on every slider pixel. */
	function save(immediate) {
		if (disposed) return;
		if (pushTimer !== null) {
			clearTimeout(pushTimer);
			pushTimer = null;
		}
		const flush = () => {
			pushTimer = null;
			void flushNow();
		};
		if (immediate === true) flush();
		else pushTimer = setTimeout(flush, PUSH_DEBOUNCE_MS);
	}

	/**
	 * Build the patch: the fields the user changed, plus payload keys that are
	 * new, changed, or gone. A field nobody touched is deliberately left out so
	 * the host keeps whatever another window put there.
	 */
	function buildPatch(map) {
		const patch = {};
		for (const key of touched) {
			patch[key] = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
		}
		// The schema stamp follows the host's value rather than the touch set:
		// it is not a user preference, it describes the document.
		if (map[SCHEMA_KEY] !== baseline.get(SCHEMA_KEY)) patch[SCHEMA_KEY] = map[SCHEMA_KEY];
		for (const [key, value] of Object.entries(map)) {
			if (PREF_KEYS.has(key) || key === SCHEMA_KEY) continue;
			if (baseline.get(key) !== value) patch[key] = value;
		}
		// Payload keys this half used to own and no longer does. The check is
		// deliberately narrow: only keys whose SHAPE this half writes are
		// candidates for deletion.
		//
		// The durable file is shared by every writer on this DSH_HOME — the host
		// half, another window, a newer build — and "I do not recognise this key"
		// is not the same statement as "this key should not exist". Reading already
		// degrades to "an unknown key we ignore"; that is the whole reason the file
		// is a flat string map. Writing has to degrade the same way, or the first
		// save after an upgrade — or after the host half stored anything of its own
		// — silently deletes it. Concretely: setting a wallpaper would take the
		// user's splash down with it.
		for (const key of baseline.keys()) {
			if (PREF_KEYS.has(key) || key === SCHEMA_KEY) continue;
			if (!key.startsWith(PAYLOAD_PREFIX)) continue;
			if (!Object.prototype.hasOwnProperty.call(map, key)) patch[key] = null;
		}
		return patch;
	}

	/** Record what the host now holds, so the next patch can subtract it. */
	function commitBaseline(patch) {
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) baseline.delete(key);
			else baseline.set(key, value);
		}
		touched.clear();
	}

	async function flushNow() {
		const map = toStore(state);
		// The seed is written before the host round-trip and regardless of whether
		// it succeeds: the point of the seed is to survive a *failed* host write.
		writeSeed(map);
		if (fetchImpl === null || !hostAvailable) return;
		const patch = buildPatch(map);
		if (Object.keys(patch).length === 0) return;
		// Serialise pushes: two overlapping merges of the same document can
		// interleave and resurrect a key the later one deleted.
		pushInFlight = (pushInFlight || Promise.resolve()).then(async () => {
			try {
				const response = await fetchImpl(apiPath, {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ method: "set", patch })
				});
				if (!response || response.ok !== true) {
					hostAvailable = false;
					hostReason = `set-${response ? response.status : "network"}`;
					notify();
					return;
				}
				commitBaseline(patch);
			} catch (error) {
				hostAvailable = false;
				hostReason = "network";
				lastError = error && error.message ? error.message : "set-failed";
				notify();
			}
		});
		await pushInFlight;
	}

	/**
	 * Load: seed first (synchronous, correct first paint), then the durable copy.
	 * Resolves with the state that ended up in memory either way — a missing
	 * host API is a degraded plugin, not a failed one.
	 */
	async function load() {
		const seed = readSeed();
		if (seed !== null) {
			// Adopting stored state is not a user change, so it must not be
			// recorded as intent — otherwise restoring a seed would rewrite every
			// field over whatever another window had set.
			state = seed;
			touched.clear();
		}
		notify();
		if (fetchImpl === null) {
			hostAvailable = false;
			hostReason = "no-fetch";
			notify();
			return state;
		}
		try {
			const response = await fetchImpl(apiPath, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ method: "get" })
			});
			if (!response || response.ok !== true) {
				hostAvailable = false;
				hostReason = `get-${response ? response.status : "network"}`;
				notify();
				return state;
			}
			const payload = await response.json();
			if (!payload || payload.ok !== true || !payload.value || typeof payload.value !== "object") {
				hostAvailable = false;
				hostReason = "get-malformed";
				notify();
				return state;
			}
			const entries = Object.entries(payload.value).filter(([, value]) => typeof value === "string");
			hostAvailable = true;
			hostReason = null;
			baseline = new Map(entries);
			touched.clear();
			if (entries.length === 0) {
				// An empty durable file means "first run". There is nothing to
				// clobber, so this is the one moment it is correct to write the
				// whole document: it turns a seed rescued from a previous origin
				// into a durable copy, and stamps the file for the next launch.
				if (seed !== null) for (const key of DOC_KEYS) touched.add(key);
			} else {
				state = fromStore(payload.value);
			}
			notify();
			if (touched.size > 0) save(true);
			return state;
		} catch (error) {
			hostAvailable = false;
			hostReason = "network";
			lastError = error && error.message ? error.message : "get-failed";
			notify();
			return state;
		}
	}

	/** Subscribe to state changes. Returns an unsubscribe function. */
	function subscribe(listener) {
		if (typeof listener !== "function") return () => {};
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Stop timers; called from the plugin's dispose effect. */
	function dispose() {
		disposed = true;
		if (pushTimer !== null) clearTimeout(pushTimer);
		pushTimer = null;
		listeners.clear();
	}

	return {
		load,
		save,
		update,
		setState,
		subscribe,
		dispose,
		getState: () => state,
		getRevision: () => revision,
		getHealth: () => ({ hostAvailable, hostReason, lastError, hasStorage: storage !== null }),
		/** Flush pending writes synchronously-ish (awaited by tests). */
		flush: flushNow,
		blobKey
	};
}

module.exports = { createStore, SEED_VERSION, SEED_PREFIX, resolveStorage };
