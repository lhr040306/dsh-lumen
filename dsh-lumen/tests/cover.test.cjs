"use strict";
/**
 * The injected guard, run as a program.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Everything else about the cover can be checked by reading the text that gets
 * injected. This cannot. Since it learned to wait for the shell's boot handoff,
 * the guard is a small state machine with a deadline, a suspension, an observer
 * and three different ways to end — and every one of its failure modes is a
 * black screen with no way back, which is the worst thing this plugin is capable
 * of doing to somebody. "It contains `setTimeout(lift, 10000)`" is not evidence
 * about any of that, and an assertion about a substring will keep passing right
 * through the regression that matters.
 *
 * So the script is taken exactly as it ships — the `text` field of the row the
 * host half contributes to `webserver/index-inject` — and run in a `vm` context
 * with a document, a timer queue, and an observer the test fires by hand.
 * Nothing about the guard is stubbed. What is stubbed is the browser.
 *
 * THE ONE THING THAT IS EASY TO GET WRONG HERE
 *
 * `assert.deepEqual` is `deepStrictEqual`, which compares prototypes, and an
 * object literal built inside a `vm` context has that context's prototypes
 * rather than this file's. Anything crossing the boundary is therefore compared
 * field by field. A `deepEqual` here would fail for a reason that has nothing to
 * do with the guard, which is the kind of failure that gets "fixed" by weakening
 * the assertion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const { createDocument } = require("./helpers/minidom.cjs");

const HOST_URL = pathToFileURL(path.join(__dirname, "..", "lib", "index.js")).href;
/** Pinned deliberately: the guard finds its own stylesheet by this string. */
const COVER_MARK = "dsh-lumen-splash-cover";
const BRIDGE = "__DSH_LUMEN_SPLASH__";
const SHELL_ROOT_ID = "root";
const BOOT_ATTRIBUTE = "data-dsh-boot";
/** The two deadlines, as documented in `lib/index.js`. */
const DEADLINE_MS = 10000;
const HELD_MS = 30000;

/** Distinct instances of the host module, so the media-name memo cannot leak across tests. */
let instanceCount = 0;

/**
 * The guard script exactly as it ships, for a splash of the given kind.
 *
 * Reached through the real injection handler rather than through an exported
 * function, because the row is the artifact — an export would let the test keep
 * passing after the row stopped carrying the script.
 */
async function guardScript(kind) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-cover-"));
	const media = kind === "video" ? "media-cover-11112222.mp4" : "media-cover-11112222.png";
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		fs.writeFileSync(path.join(home, "lumen.json"), JSON.stringify({ "splash.media": media, "dsh-lumen:schema-version": "1" }));
		instanceCount += 1;
		const host = await import(`${HOST_URL}?instance=${instanceCount}`);
		const handlers = [];
		host.apply({
			effect: (fn) => fn(),
			on: (event, handler) => {
				if (event === "webserver/index-inject") handlers.push(handler);
				return () => {};
			},
			webServer: { register: () => () => {} },
			webRuntime: { trustedHosts: [] },
			// Present so the load-time notice about a missing host gate stays quiet;
			// this file is about the guard, not about the fence.
			connection: { requestRejection: () => undefined }
		});
		const table = [];
		handlers[0](table);
		const row = table.find((entry) => entry.kind === "script");
		assert.ok(row, "the host half contributed no guard script for a configured splash");
		return row.text;
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
}

/**
 * A browser: a document, a timer queue, and observers the test fires by hand.
 *
 * The observer is the whole reason this double is worth writing. A real one
 * delivers on a microtask the test cannot see or order, so "the shell replaced
 * the boot kernel" would be a race — and the assertions that matter are all
 * about what does and does not happen *at* that moment.
 */
function createBrowser() {
	const document = createDocument();
	document.readyState = "loading";
	const timers = [];
	const observers = [];
	let nextTimer = 0;

	const sandbox = {};
	sandbox.window = sandbox;
	sandbox.document = document;
	sandbox.setTimeout = (fn, ms) => {
		nextTimer += 1;
		timers.push({ id: nextTimer, fn, ms, cancelled: false, fired: false });
		return nextTimer;
	};
	sandbox.clearTimeout = (id) => {
		for (const timer of timers) if (timer.id === id) timer.cancelled = true;
	};
	sandbox.MutationObserver = class MutationObserverDouble {
		constructor(callback) {
			this.callback = callback;
			this.targets = [];
			this.disconnected = false;
			observers.push(this);
		}
		observe(target, init) {
			this.targets.push({ target, init });
		}
		disconnect() {
			this.disconnected = true;
		}
	};
	vm.createContext(sandbox);

	return {
		sandbox,
		document,
		observers,
		/** Timers still standing: not cancelled, not fired. */
		pending: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
		/** Run every timer still standing, as a browser would when their time came. */
		runTimers() {
			for (const timer of timers) {
				if (timer.cancelled || timer.fired) continue;
				timer.fired = true;
				timer.fn();
			}
		},
		/** Deliver a mutation to every live observer. */
		pump() {
			for (const observer of observers) {
				if (observer.disconnected) continue;
				observer.callback([], observer);
			}
		},
		/** Whatever the page could use to reach the guard. */
		bridge: () => sandbox[BRIDGE],
		/** The styled elements still in the head. */
		styles: () => document.head.getElementsByTagName("style"),
		/** Whether our cover stylesheet is still in the document. */
		covered: (cover) => document.head.getElementsByTagName("style").includes(cover)
	};
}

/** Put a stylesheet in the head, as the injected row would have. */
function plantCover(document, marked) {
	const style = document.createElement("style");
	style.textContent = marked === false ? "/* somebody else's sheet */" : `/* ${COVER_MARK} */\n#${SHELL_ROOT_ID}{visibility:hidden!important}`;
	document.head.appendChild(style);
	return style;
}

/** Parse the container into the body. */
function mountShell(document) {
	const root = document.createElement("div");
	root.id = SHELL_ROOT_ID;
	document.body.appendChild(root);
	return root;
}

/** The boot kernel, as the shell renders it into the container. */
function mountKernel(document, root) {
	const kernel = document.createElement("div");
	kernel.setAttribute(BOOT_ATTRIBUTE, "");
	root.appendChild(kernel);
	return kernel;
}

/** The app taking over: the kernel goes, the app appears. */
function handOver(document, root, kernel) {
	kernel.remove();
	root.appendChild(document.createElement("main"));
}

/** The parser finishing, which is when the guard starts watching. */
function parse(browser) {
	browser.document.readyState = "interactive";
	browser.document.dispatch("DOMContentLoaded");
}

// ── the handle ──────────────────────────────────────────────────────────────

test("the guard publishes a handle and stands exactly one bounded deadline", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);

	const bridge = browser.bridge();
	assert.ok(bridge, "the page has no way to reach the guard");
	assert.equal(typeof bridge.lift, "function");
	assert.equal(typeof bridge.keep, "function");
	const pending = browser.pending();
	assert.equal(pending.length, 1, "one cover should mean one deadline");
	assert.equal(pending[0].ms, DEADLINE_MS, "the deadline is not the documented one");
	// Nothing has happened yet, so nothing should have come down.
	assert.equal(browser.covered(cover), true);
});

test("lifting removes our stylesheet and leaves everybody else's alone", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	const theirs = plantCover(browser.document, false);
	vm.runInContext(await guardScript("image"), browser.sandbox);

	browser.bridge().lift();

	assert.equal(browser.covered(cover), false, "the cover survived a lift");
	assert.equal(browser.styles().includes(theirs), true, "the guard removed a stylesheet it did not own");
});

test("the release is one-way and idempotent", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);
	const bridge = browser.bridge();

	bridge.lift();
	bridge.lift();
	browser.runTimers();

	assert.equal(browser.covered(cover), false);
	assert.equal(browser.pending().length, 0, "a lifted cover left a deadline standing behind it");
	assert.equal(browser.observers.every((observer) => observer.disconnected), true, "a lifted cover left an observer watching");
});

// ── the handoff, which is the interesting part ──────────────────────────────

test("the cover stands while the boot kernel does, and lifts when the shell replaces it", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);
	const root = mountShell(browser.document);
	const kernel = mountKernel(browser.document, root);
	parse(browser);

	browser.pump();
	assert.equal(browser.covered(cover), true, "the cover lifted while the boot kernel was still standing");

	handOver(browser.document, root, kernel);
	browser.pump();

	assert.equal(browser.covered(cover), false, "the cover outlived the handoff");
	assert.equal(browser.pending().length, 0, "the deadline was left armed after the cover came down");
});

test("an empty container is not a shell that has taken over, and one with content is", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);
	// No boot kernel at all: a legal shape, since the shell only renders one when
	// it has boot markup to hand over.
	const root = mountShell(browser.document);
	parse(browser);

	browser.pump();
	assert.equal(browser.covered(cover), true, "an empty container was read as the shell having taken over");

	root.appendChild(browser.document.createElement("main"));
	browser.pump();
	assert.equal(browser.covered(cover), false, "the app rendered and the cover stayed");
});

test("the handoff is watched for from the document, not from a container that may not exist yet", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);

	// The realistic ordering: this script sits in the head, so the parser has not
	// reached the body when it runs, and the container does not exist yet.
	const observed = browser.observers;
	parse(browser);
	assert.equal(observed.length, 1, "the guard installed no observer, so the handoff would only be noticed by the deadline");
	assert.equal(observed[0].targets.length, 1);
	assert.equal(observed[0].targets[0].target, browser.document.documentElement, "the guard watched a node that may never appear");
	// Field by field: the init object was built in another realm.
	assert.equal(observed[0].targets[0].init.childList, true);
	assert.equal(observed[0].targets[0].init.subtree, true);

	// The container appears after the guard started watching, and is still noticed.
	const root = mountShell(browser.document);
	const kernel = mountKernel(browser.document, root);
	browser.pump();
	assert.equal(browser.covered(cover), true, "the cover lifted before the app existed");
	handOver(browser.document, root, kernel);
	browser.pump();
	assert.equal(browser.covered(cover), false, "the cover missed a handoff that happened after the observer was installed");
});

// ── the two ways out that do not depend on the shell ────────────────────────

test("the deadline lifts the cover even if nothing else ever happens", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);
	const root = mountShell(browser.document);
	mountKernel(browser.document, root);
	parse(browser);
	browser.pump();
	assert.equal(browser.covered(cover), true, "the cover should still be up at this point");

	browser.runTimers();
	assert.equal(browser.covered(cover), false, "a start that never completes must still give the interface back");
});

test("a document with no container at all yields the screen on the deadline", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	vm.runInContext(await guardScript("image"), browser.sandbox);
	// A page that is not the shell's, or a build that renamed the container.
	parse(browser);
	browser.pump();
	assert.equal(browser.covered(cover), true);

	browser.runTimers();
	assert.equal(browser.covered(cover), false);
});

test("keep postpones the deadline instead of cancelling it, and stays bounded", async () => {
	const browser = createBrowser();
	const cover = plantCover(browser.document);
	// A clip: the browser half needs the black behind it until a frame is
	// actually playing, which is the only thing `keep` exists for.
	vm.runInContext(await guardScript("video"), browser.sandbox);
	const root = mountShell(browser.document);
	const kernel = mountKernel(browser.document, root);
	parse(browser);

	browser.bridge().keep();
	const pending = browser.pending();
	assert.equal(pending.length, 1, "keep must leave one deadline standing, not zero");
	assert.equal(pending[0].ms, HELD_MS, "keep should lengthen the deadline rather than remove it");

	// While held, the handoff alone must not take the cover down.
	handOver(browser.document, root, kernel);
	browser.pump();
	assert.equal(browser.covered(cover), true, "a held cover came down on the handoff anyway");

	// And a page that held the cover and then stopped being able to lift it must
	// still lose the screen rather than own it.
	browser.runTimers();
	assert.equal(browser.covered(cover), false, "a bounded suspension turned into an unbounded one");
});
