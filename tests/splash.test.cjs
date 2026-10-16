"use strict";
/**
 * The splash's browser half, against a host that answers.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *
 * Not "does it mount a <video>". The parts of this module that can strand a user
 * are the *transitions*: it must not touch the release for a picture (the
 * injected guard owns that, and a second opinion would fight it), it must
 * suspend the guard before the clip is mounted rather than after, and every way
 * the clip can fail has to end with the layer gone and the interface revealed.
 * A test that only checked the happy path would pass with all of those wrong.
 *
 * Timers and the guard are both doubles the test drives by hand, for the same
 * reason: every interesting question here is "what happens at that moment".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDocument } = require("./helpers/minidom.cjs");
const { createSplash, ACCEPTED_TYPES, LAYER_ATTRIBUTE, LAYER_Z_INDEX, MEDIA_PATH, UPLOAD_PATH, CLEAR_PATH, COVER_BRIDGE } = require("../src/splash.cjs");

/** A translator that returns the key, so assertions can name the string. */
const t = (key) => key;

/** Let the module's own promise chains settle. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A host answer with the two fields the module actually reads. */
function jsonResponse(status, payload, headers) {
	const table = headers || {};
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name) => (Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null) },
		json: async () => payload
	};
}

/** A guard double that counts what the page asked of it. */
function makeBridge() {
	const calls = { lift: 0, keep: 0 };
	return {
		calls,
		bridge: {
			lift() {
				calls.lift += 1;
			},
			keep() {
				calls.keep += 1;
			}
		}
	};
}

/**
 * A window with a timer queue the test fires, and an optional guard on it.
 *
 * `createWindow` from the mini DOM would give real timers, and the whole point
 * of the two deadlines is that they are the last resort — a test that has to
 * wait eight seconds to observe one will not be written, so the observation
 * would be skipped and the deadline untested.
 */
function makeWindow(bridge) {
	const timers = [];
	const target = {
		setTimeout(fn, ms) {
			timers.push({ fn, ms, cancelled: false, fired: false });
			return timers.length;
		},
		clearTimeout(id) {
			const timer = timers[id - 1];
			if (timer !== undefined) timer.cancelled = true;
		}
	};
	if (bridge !== undefined) target[COVER_BRIDGE] = bridge;
	return {
		win: target,
		timers,
		pending: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
		/** Fire the timers armed for exactly `ms`, as the browser would. */
		fire(ms) {
			for (const timer of timers) {
				if (timer.cancelled || timer.fired || timer.ms !== ms) continue;
				timer.fired = true;
				timer.fn();
			}
		}
	};
}

/** Everything a test needs, with the host answering whatever it was told to. */
function makeRealm(options) {
	const opts = options || {};
	const document = createDocument();
	// A container, so "the layer is not inside it" is a statement with something
	// to be wrong about.
	const root = document.createElement("div");
	root.id = "root";
	document.body.appendChild(root);

	const calls = [];
	const guard = opts.bridge === undefined ? makeWindow() : makeWindow(opts.bridge);
	const fetchImpl = opts.fetch === undefined
		? async (url, init) => {
			calls.push({ url, init });
			const answer = opts.answer === undefined ? jsonResponse(404, null) : opts.answer(url, init);
			return answer;
		}
		: opts.fetch;

	const splash = createSplash({ t, fetchImpl, window: guard.win, document });
	return { document, root, splash, calls, guard, bridge: opts.bridge };
}

/** The layer this half owns, if it is mounted. */
function findLayer(document) {
	return document.body.queryAll((el) => el.getAttribute(LAYER_ATTRIBUTE) !== null);
}

// ── asking the host what the splash is ─────────────────────────────────────

test("probe reads the host's answer, and treats 404 as 'not set' rather than as a fault", async () => {
	const missing = makeRealm({ answer: () => jsonResponse(404, { ok: false }) });
	assert.deepEqual(await missing.splash.probe(), { configured: false, kind: null, bytes: 0 });

	const picture = makeRealm({ answer: () => jsonResponse(200, null, { "content-type": "image/png", "content-length": "4096" }) });
	assert.deepEqual(await picture.splash.probe(), { configured: true, kind: "image", bytes: 4096 });

	const clip = makeRealm({ answer: () => jsonResponse(200, null, { "content-type": "video/mp4; codecs=avc1", "content-length": "2048" }) });
	assert.deepEqual(await clip.splash.probe(), { configured: true, kind: "video", bytes: 2048 });

	// A host that is there but unhappy is not "no splash" — the panel says so
	// rather than telling the user their splash is gone.
	const broken = makeRealm({ answer: () => jsonResponse(500, null) });
	assert.equal(await broken.splash.probe(), null);

	const offline = makeRealm({ fetch: async () => { throw new Error("offline"); } });
	assert.equal(await offline.splash.probe(), null);

	// No channel at all: no request is made and the answer is "unknown", which is
	// a different sentence from "not set".
	const channel = makeRealm({ fetch: null });
	assert.equal(await channel.splash.probe(), null);
	assert.equal(channel.calls.length, 0, "a store with no host channel made a request anyway");
});

test("probe asks the route the host owns, and asks it without a body", async () => {
	const realm = makeRealm({ answer: () => jsonResponse(404, null) });
	await realm.splash.probe();
	assert.equal(realm.calls.length, 1);
	assert.equal(realm.calls[0].url, MEDIA_PATH);
	assert.equal(realm.calls[0].init.method, "HEAD", "a probe must not pull the media down");
});

// ── sending a file ─────────────────────────────────────────────────────────

test("upload sends the file's own bytes under the file's own type", async () => {
	const file = { name: "splash.mp4", type: "video/mp4", size: 900 };
	const realm = makeRealm({ answer: () => jsonResponse(200, { ok: true, value: { media: "media-x-1234abcd.mp4", kind: "video", bytes: 900 } }) });
	const result = await realm.splash.upload(file);

	assert.deepEqual(result, { ok: true, media: "media-x-1234abcd.mp4", kind: "video", bytes: 900 });
	assert.equal(realm.calls.length, 1);
	assert.equal(realm.calls[0].url, UPLOAD_PATH);
	assert.equal(realm.calls[0].init.method, "POST");
	assert.equal(realm.calls[0].init.headers["content-type"], "video/mp4");
	assert.equal(realm.calls[0].init.body, file, "the file must be the body, not a re-encoded copy of it");
});

test("upload reports the host's own reason instead of guessing at one", async () => {
	const refused = makeRealm({ answer: () => jsonResponse(415, { ok: false, error: { code: "unsupported-media-type" } }) });
	assert.deepEqual(await refused.splash.upload({ type: "image/png", size: 1 }), { ok: false, reason: "unsupported-media-type" });

	const tooLarge = makeRealm({ answer: () => jsonResponse(413, { ok: false, error: { code: "payload-too-large" } }) });
	assert.deepEqual(await tooLarge.splash.upload({ type: "image/png", size: 1 }), { ok: false, reason: "payload-too-large" });

	// A response with no JSON at all still produces a reason rather than a throw.
	const opaque = makeRealm({ answer: () => ({ status: 502, ok: false, headers: { get: () => null }, json: async () => { throw new Error("not json"); } }) });
	assert.deepEqual(await opaque.splash.upload({ type: "image/png", size: 1 }), { ok: false, reason: "upload-502" });
});

test("upload refuses a type it was never going to be allowed to send", async () => {
	const realm = makeRealm({ answer: () => jsonResponse(200, { ok: true, value: {} }) });
	for (const type of ["application/pdf", "text/plain", "video/quicktime", ""]) {
		assert.deepEqual(await realm.splash.upload({ type, size: 1 }), { ok: false, reason: "unsupported-type" });
	}
	assert.equal(realm.calls.length, 0, "a file that cannot be sent must not be sent");
});

test("clear reports whether there was anything to remove", async () => {
	const removed = makeRealm({ answer: () => jsonResponse(200, { ok: true, value: { cleared: true } }) });
	assert.deepEqual(await removed.splash.clear(), { ok: true, cleared: true });
	assert.equal(removed.calls[0].url, CLEAR_PATH);
	assert.equal(removed.calls[0].init.method, "POST");

	const nothing = makeRealm({ answer: () => jsonResponse(200, { ok: true, value: { cleared: false } }) });
	assert.deepEqual(await nothing.splash.clear(), { ok: true, cleared: false });
});

// ── the boot lifecycle ─────────────────────────────────────────────────────

test("with no injected cover, nothing is asked and nothing is mounted", async () => {
	const realm = makeRealm({});
	realm.splash.startCover();
	await settle();

	assert.equal(realm.splash.inspect().phase, "no-cover");
	assert.equal(realm.calls.length, 0, "a page served without a cover is not a page with a splash to play");
	assert.deepEqual(findLayer(realm.document), []);
});

test("a picture is left entirely to the guard, release included", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "image/webp" }) });
	realm.splash.startCover();
	await settle();

	assert.equal(realm.splash.inspect().phase, "guard-only");
	assert.equal(calls.keep, 0, "suspending the guard for a picture would hold the cover past the handoff for no reason");
	assert.equal(calls.lift, 0, "the guard owns the release for a picture; a second opinion would fight it");
	assert.deepEqual(findLayer(realm.document), [], "a picture is painted by the stylesheet, not by an element");
});

test("a clip suspends the guard before it mounts, and reveals on the first frame", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/webm" }) });
	realm.splash.startCover();
	await settle();

	assert.equal(calls.keep, 1, "the clip must hold the cover itself, or the handoff will reveal the interface mid-black");
	const layers = findLayer(realm.document);
	assert.equal(layers.length, 1, "no clip layer was mounted");
	const layer = layers[0];
	assert.equal(layer.style.position, "fixed");
	assert.equal(layer.style.zIndex, String(LAYER_Z_INDEX), "the layer has to sit above the wallpaper layer and any floating widget");
	assert.equal(realm.root.contains(layer), false, "a layer inside #root would be hidden by the very cover it replaces");

	const clips = layer.queryAll((el) => el.tagName === "VIDEO");
	assert.equal(clips.length, 1, "the layer has no clip in it");
	assert.equal(clips[0].getAttribute("playsinline") !== null, true);
	assert.equal(clips[0].muted, true, "an unmuted clip is refused by every autoplay policy, which means no splash at all");
	assert.equal(clips[0].src, MEDIA_PATH);
	assert.ok(layer.queryAll((el) => el.textContent === "splash.skip").length === 1, "there is no way to skip the clip");

	// The clip starts: the cover can go, but the layer stays until the clip does.
	clips[0].dispatch("playing", {});
	assert.equal(calls.lift, 1, "the first frame did not release the cover");
	assert.equal(findLayer(realm.document).length, 1, "the layer was taken down the moment it started");

	clips[0].dispatch("ended", {});
	assert.deepEqual(findLayer(realm.document), [], "the layer outlived the clip");
	assert.equal(calls.lift, 1, "a dismissal should not lift a cover that is already lifted");
});

test("a clip that cannot decode takes the layer down and gives the interface back", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	await settle();
	const clip = findLayer(realm.document)[0].queryAll((el) => el.tagName === "VIDEO")[0];

	clip.dispatch("error", {});
	assert.deepEqual(findLayer(realm.document), [], "a clip that will not play left an opaque rectangle over the interface");
	assert.equal(calls.lift, 1, "a clip that will not play left the cover up");
});

test("a frame that never arrives gives way on its own deadline", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	await settle();
	assert.equal(findLayer(realm.document).length, 1);

	// The first-frame deadline. Nothing was dispatched: this is a clip that
	// silently never starts, which is the case no event reports.
	realm.guard.fire(8000);
	assert.deepEqual(findLayer(realm.document), [], "a clip that never started kept the interface covered");
	assert.equal(calls.lift, 1);
});

test("a clip has a total lifetime, however well it plays", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	await settle();
	const clip = findLayer(realm.document)[0].queryAll((el) => el.tagName === "VIDEO")[0];
	clip.dispatch("playing", {});

	realm.guard.fire(120000);
	assert.deepEqual(findLayer(realm.document), [], "a stalled clip kept the layer past its total budget");
	assert.equal(calls.lift, 1);
});

test("a click anywhere, or any key, ends the clip early", async () => {
	const byClick = makeBridge();
	const clickRealm = makeRealm({ bridge: byClick.bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	clickRealm.splash.startCover();
	await settle();
	findLayer(clickRealm.document)[0].dispatch("click", {});
	assert.deepEqual(findLayer(clickRealm.document), []);
	assert.equal(byClick.calls.lift, 1);

	const byKey = makeBridge();
	const keyRealm = makeRealm({ bridge: byKey.bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	keyRealm.splash.startCover();
	await settle();
	keyRealm.document.dispatch("keydown", {});
	assert.deepEqual(findLayer(keyRealm.document), []);
	assert.equal(byKey.calls.lift, 1);
});

test("the last resort still runs if the first frame never comes and nothing else fires", async () => {
	const { bridge } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	await settle();
	// Every timer is still armed right after mounting; none of them may have been
	// forgotten, which is the failure a "happy path only" test would miss.
	assert.equal(realm.guard.pending().length, 2, "a clip with no deadline is a clip that can own the screen");
});

// ── teardown ───────────────────────────────────────────────────────────────

test("dispose takes the layer down and stops listening", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	await settle();

	realm.splash.dispose();
	assert.deepEqual(findLayer(realm.document), [], "the layer outlived the plugin, which is the one thing it must never do");
	assert.equal(calls.lift, 1, "disposing mid-clip must give the interface back rather than leave it covered");

	// The listeners went with it: nothing left behind can act on a dead module.
	const after = calls.lift;
	realm.document.dispatch("keydown", {});
	assert.equal(calls.lift, after, "a listener outlived the module it belonged to");
});

test("startCover runs once, however often it is called", async () => {
	const { bridge, calls } = makeBridge();
	const realm = makeRealm({ bridge, answer: () => jsonResponse(200, null, { "content-type": "video/mp4" }) });
	realm.splash.startCover();
	realm.splash.startCover();
	await settle();
	assert.equal(realm.calls.length, 1, "a second boot would be a second probe and a second layer");
	assert.equal(calls.keep, 1);
	assert.equal(findLayer(realm.document).length, 1);
});

// ── the table the two halves share ─────────────────────────────────────────

test("classify agrees with the table the module publishes", () => {
	for (const [type, kind] of ACCEPTED_TYPES) {
		const realm = makeRealm({ fetch: null });
		assert.equal(realm.splash.classify(type), kind, `${type} was classified as something else`);
		assert.equal(realm.splash.classify(type.toUpperCase()), kind, "a type is matched case-insensitively in a browser");
	}
	assert.equal(makeRealm({ fetch: null }).splash.classify("video/quicktime"), null);
	assert.equal(makeRealm({ fetch: null }).splash.classify(undefined), null);
});

// ── stacking: the one place this plugin competes with its neighbours ───────

test("the clip layer takes the largest z-index CSS accepts, and sits in front of the wallpaper", () => {
	// Two independent sides, and a number that is wrong on either side produces
	// the same visible bug: a black cover that plays *behind* something.
	//
	// The wallpaper side is read out of the engine rather than restated, because
	// the relationship that matters is "the wallpaper is behind the app and the
	// splash is in front of it" — not two constants that happen to look right.
	const fs = require("node:fs");
	const path = require("node:path");

	const engineSource = fs.readFileSync(path.join(__dirname, "..", "src", "engine.cjs"), "utf8");
	const rootRule = /\[[^\]]*="root"\]\{[^}]*z-index:([^;]+);/.exec(engineSource);
	assert.ok(rootRule, "the wallpaper layer's z-index rule was not found in engine.cjs");
	const wallpaperZ = parseFloat(rootRule[1]);
	assert.ok(Number.isFinite(wallpaperZ), `the wallpaper layer's z-index is not a number: ${rootRule[1]}`);
	assert.ok(wallpaperZ < 0, "the wallpaper layer is meant to sit behind the app, so its z-index must be negative");
	assert.ok(LAYER_Z_INDEX > 0, "the splash layer is meant to sit in front of the app, so its z-index must be positive");

	// The upper side, and this assertion *is* the proof rather than a proxy for
	// it: 2147483647 is the largest value CSS accepts, so no element that obeys
	// the property can be painted above this layer. Measuring a particular
	// neighbour instead would be both weaker and more fragile — it would go
	// stale the moment that neighbour changed, and it would say nothing about
	// the neighbours nobody thought to measure.
	//
	// Asserted rather than derived so that lowering it is a deliberate edit with
	// a failing test attached, not a quiet tweak.
	assert.equal(LAYER_Z_INDEX, 2147483647, "the splash layer should use the largest z-index CSS accepts");
	assert.ok(wallpaperZ < LAYER_Z_INDEX, "the splash layer must sit above the wallpaper layer");
});
