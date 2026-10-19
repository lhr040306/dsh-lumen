"use strict";
/**
 * The settings panel.
 *
 * WHY THE GLOBAL `document` IS INSTALLED FIRST
 *
 * `ui/dom.cjs` reads `document` from scope rather than taking it as an argument,
 * which is what lets one builder render into both DSH's React tree and the
 * standalone preview page with no host-specific plumbing. The cost is that the
 * module cannot be exercised without a document, so this file installs the
 * minidom as the global before touching it — exactly the situation the module
 * is written for. Node's test runner gives each file its own process, so the
 * global does not leak into the other suites.
 *
 * What is asserted here is not "the panel looks right" — that is the preview's
 * job, against a real engine. It is the handful of invariants that would be
 * invisible in a screenshot: that every label comes from the translator, that an
 * interaction writes through to the store and not just to the widget, that a
 * raised readability floor is disclosed rather than silently applied, and that
 * teardown actually detaches.
 *
 * WHY THE DECODER IS STUBBED TOO
 *
 * "Set as both" is one gesture that writes to two places, and the interesting
 * case is not that it works — it is what the panel says when one half lands and
 * the other does not. Provoking that needs the decoder to fail on demand, which
 * a real canvas cannot be told to do. The stub is installed before
 * `ui/panel.cjs` is required because that module destructures `prepareImage` at
 * load time; patching afterwards would edit a property nobody reads.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { MiniElement, MiniText, createDocument, createWindow, createStorage, createStyle } = require("./helpers/minidom.cjs");

const g = globalThis;
g.document = createDocument();
g.HTMLElement = MiniElement;
g.Node = MiniElement;
g.Text = MiniText;

// ── the decoder stub, installed before the panel is loaded ──────────────────

const image = require("../src/image.cjs");
/** Swapped per test; null means "this file does not decode". */
let decodePlan = null;
image.prepareImage = async (file) => {
	if (decodePlan === null) throw new Error("decode-failed");
	return decodePlan(file);
};

const { createPanel, itemLabel, formatDuration, formatClockStamp } = require("../src/ui/panel.cjs");
const { createStore } = require("../src/store.cjs");
const { RECIPES } = require("../src/wallpapers.cjs");
const { createTranslator, NS } = require("../src/i18n.cjs");
const { ACTIVE_ATTR } = require("../src/engine.cjs");

/** Every element in a subtree, this one included. */
function walk(node, out) {
	const found = out || [];
	found.push(node);
	for (const child of node.childNodes || []) walk(child, found);
	return found;
}

/** All elements carrying a class. */
function byClass(root, name) {
	return walk(root).filter((el) => el.nodeType === 1 && el.classList.contains(name));
}

/**
 * The visible text of a subtree.
 *
 * `MiniElement.textContent` already recurses through child nodes and prefers an
 * element's own text, which is exactly how the DOM builder stores strings (it
 * assigns `textContent`, it does not append text nodes). Walking for text nodes
 * only would therefore see almost nothing.
 */
function textOf(node) {
	return node.textContent === null || node.textContent === undefined ? "" : String(node.textContent);
}

/** A stub engine: the panel only reads `inspect()` and calls render/reschedule. */
function createEngineStub() {
	const calls = { render: 0, reschedule: 0 };
	const state = { requiredAlpha: 0, missed: 0 };
	return {
		calls,
		setRequirement: (alpha) => {
			state.requiredAlpha = alpha;
		},
		setMissed: (n) => {
			state.missed = n;
		},
		render: () => {
			calls.render += 1;
		},
		reschedule: () => {
			calls.reschedule += 1;
		},
		inspect: () => ({ requiredAlpha: state.requiredAlpha, plan: { missed: state.missed }, hasDom: true, active: true })
	};
}

/**
 * A stub splash channel: the four calls the panel makes, and a log of them.
 *
 * The panel only ever reads `classify`, `probe`, `upload` and `clear`, so this
 * is the whole surface — if the panel ever reaches for something else the
 * undefined property shows up as a failure rather than being quietly tolerated.
 */
function createSplashStub(options) {
	const o = options || {};
	const calls = { probe: 0, upload: [], clear: 0 };
	const probeAnswer = o.probe || { configured: false, kind: null, bytes: 0 };
	const uploadAnswer = o.upload || ((file) => ({ ok: true, kind: file.type.indexOf("video") === 0 ? "video" : "image", bytes: Number(file.size) || 0 }));
	const clearAnswer = o.clear || { ok: true, cleared: true };
	return {
		calls,
		classify: (type) => {
			if (typeof type !== "string") return null;
			if (type.indexOf("video/") === 0) return /^video\/(mp4|webm|ogg)$/.test(type) ? "video" : null;
			if (type.indexOf("image/") === 0) return /^image\/(png|jpeg|webp|gif|avif)$/.test(type) ? "image" : null;
			return null;
		},
		probe: async () => {
			calls.probe += 1;
			return typeof probeAnswer === "function" ? probeAnswer() : probeAnswer;
		},
		upload: async (file) => {
			calls.upload.push(file);
			return uploadAnswer(file);
		},
		clear: async () => {
			calls.clear += 1;
			return typeof clearAnswer === "function" ? clearAnswer() : clearAnswer;
		}
	};
}

/**
 * The splash's own file input.
 *
 * The panel has two pickers when a splash channel exists, and telling them
 * apart by position would make this test fail for the wrong reason the day the
 * section order changes. The `accept` string is the thing that actually
 * distinguishes them, and asserting on it also proves the picker advertises
 * clips — a picker offering only `image/*` would look identical in a screenshot.
 */
function splashPickerOf(panel) {
	const inputs = walk(panel.el).filter((el) => el.nodeType === 1 && el.tagName === "INPUT" && el.getAttribute("accept") === "image/*,video/*");
	assert.equal(inputs.length, 1, "the panel should expose exactly one splash picker");
	return inputs[0];
}

/** Hand a batch to the splash picker the way a user selection does. */
function chooseSplash(panel, files) {
	const picker = splashPickerOf(panel);
	picker.files = files;
	picker.dispatch("change", {});
	return picker;
}

/**
 * Which destinations the staged file is currently offered, in render order.
 *
 * Scoped by the destination labels rather than by DOM position, because the
 * assertion that matters is "the wallpaper button is not there for a clip" and
 * a position-based lookup would need updating every time the row is reordered.
 */
function targetNames(panel, t) {
	const pairs = [
		["wallpaper", t("splash.apply.wallpaper")],
		["splash", t("splash.apply.splash")],
		["both", t("splash.apply.both")]
	];
	const found = [];
	for (const el of walk(panel.el)) {
		if (el.nodeType !== 1 || el.tagName !== "BUTTON") continue;
		const hit = pairs.find((pair) => pair[1] === textOf(el));
		if (hit) found.push(hit[0]);
	}
	return found;
}

/** Click one of the destination buttons by name. */
function clickTarget(panel, t, name) {
	const label = { wallpaper: t("splash.apply.wallpaper"), splash: t("splash.apply.splash"), both: t("splash.apply.both") }[name];
	const btn = walk(panel.el).find((el) => el.nodeType === 1 && el.tagName === "BUTTON" && textOf(el) === label);
	assert.ok(btn, `the "${name}" destination button was not rendered`);
	btn.dispatch("click", {});
	return btn;
}

/** Let the panel's async handlers settle. */
async function flush() {
	for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A `File`-shaped object — only the fields the panel and the stub read matter. */
function splashFile(name, type, size) {
	return { name, type, size: size === undefined ? 4096 : size };
}

function makePanel(options) {
	const opts = options || {};
	const document = createDocument();
	const win = createWindow(document);
	// The builder reads this at call time; a fresh document per panel keeps the
	// assertions isolated.
	g.document = document;
	// Declared per panel rather than reset by hand, so a test that forgets to
	// clear it cannot inherit the previous test's decoder.
	decodePlan = opts.decode || null;
	const store = createStore({ apiPath: "/lumen/api", storage: createStorage(), fetchImpl: null });
	const engine = createEngineStub();
	if (opts.setup) opts.setup(store);
	const t = createTranslator(opts.lang === "en" ? "en" : "zh");
	const splash = opts.splash || null;
	const panel = createPanel({ store, engine, splash, t, lang: opts.lang, window: win, document });
	return { document, win, store, engine, panel, t, splash };
}

test("the panel registers its stylesheet once and builds the expected sections", () => {
	const { document, panel } = makePanel();
	const styles = document.documentElement.queryAll((el) => el.id === "dsh-lumen-panel-style");
	assert.equal(styles.length, 1, "the panel stylesheet was not injected exactly once");
	const root = panel.el;
	assert.ok(root.classList.contains("lumen-root"));
	assert.equal(byClass(root, "lumen-hero").length, 1);
	assert.ok(byClass(root, "lumen-card").length >= 4, "hero, builtin, custom, rotation, appearance and status are expected");
	panel.destroy();
});

test("no user-facing text is hardcoded: every label resolves through the translator", () => {
	// A hardcoded string is invisible in the language the author writes in and
	// only shows up as a stray Chinese word in the English UI.
	const pairs = [];
	for (const lang of ["zh", "en"]) {
		const { panel, document } = makePanel({ lang });
		pairs.push({ lang, text: textOf(panel.el), document });
		panel.destroy();
	}
	const [zh, en] = pairs;
	assert.ok(zh.text.length > 200, "the panel rendered almost no text");
	assert.notEqual(zh.text, en.text, "the panel rendered identically in both languages");
	// The English column must not carry Chinese, which is what a missed
	// translation looks like.
	assert.equal(/[\u4e00-\u9fff]/.test(en.text), false, "the English panel leaked untranslated Chinese");
});

test("a raised readability floor is disclosed, not silently applied", () => {
	const { panel, store, engine, t } = makePanel();
	// The comparison the panel must make is against what the *user asked for*,
	// so give it a thin wash first — otherwise a requirement below the default
	// opacity is correctly silent.
	store.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.3, readability: true };
		return draft;
	});
	const note = () => byClass(panel.el, "lumen-note").map((el) => el.textContent).join(" | ");
	// The wash hint is one specific note among several (the "missed triggers"
	// note is permanently `is-warn`), so find it by its text rather than by
	// scanning every note on the panel.
	const noteWith = (needle) => byClass(panel.el, "lumen-note").find((el) => String(el.textContent).indexOf(needle) >= 0);

	engine.setRequirement(0.1);
	panel.sync();
	assert.equal(note().indexOf(t("appearance.opacity.hint")) >= 0, true, "the plain hint should be shown when nothing was raised");
	assert.equal(noteWith(t("appearance.opacity.hint")).classList.contains("is-warn"), false, "nothing was raised, so nothing should be flagged");

	// What the engine actually does over a bright picture: the solved floor
	// exceeds what the user asked for.
	engine.setRequirement(0.62);
	panel.sync();
	// The engine solves in veil terms (0.62), the slider is in picture terms, so
	// the disclosure has to print the complement — the number the user is looking
	// at. "Raised to 62%" beside a slider reading 38% reads as a bug.
	const raised = note();
	assert.equal(raised.indexOf("38") >= 0, true, `the raised floor was not disclosed: ${raised}`);
	assert.equal(noteWith("38").classList.contains("is-warn"), true, "the disclosure was not marked as a warning");

	// Turning the floor off stops the disclosure, even though the engine still
	// reports a requirement — the user opted out of it.
	store.update((draft) => {
		draft.wash = { ...draft.wash, readability: false };
		return draft;
	});
	panel.sync();
	assert.equal(note().indexOf("62"), -1, "the disclosure survived the opt-out");
	panel.destroy();
});

test("clicking a recipe chip writes the wallpaper through to the store", () => {
	const { panel, store, engine } = makePanel();
	const chips = byClass(panel.el, "lumen-chip");
	assert.equal(chips.length, RECIPES.length, "the chip strip does not match the library");
	const before = store.getState().single.ref;
	const target = chips.find((chip) => chip.dataset.recipe !== before);
	assert.ok(target, "no chip to click");
	target.click();
	const after = store.getState().single;
	assert.equal(after.kind, "recipe");
	assert.notEqual(after.ref, before, "clicking a chip did not change the wallpaper");
	assert.equal(after.ref, target.dataset.recipe);
	assert.ok(engine.calls.render > 0, "the panel did not ask the engine to repaint");
	panel.destroy();
});

test("the current recipe is marked in the chip strip", () => {
	const { panel, store } = makePanel();
	store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "dune" };
		return draft;
	});
	panel.sync();
	const on = byClass(panel.el, "lumen-chip").filter((chip) => chip.classList.contains("is-on"));
	assert.equal(on.length, 1, `expected exactly one marked chip, found ${on.length}`);
	assert.equal(on[0].dataset.recipe, "dune");
	panel.destroy();
});

test("enabling rotation switches the mode and asks the engine to reschedule", () => {
	const { panel, store, engine } = makePanel();
	store.update((draft) => {
		draft.playlist = [{ id: "r1", kind: "recipe", ref: "aurora", seed: "s1" }];
		return draft;
	});
	panel.sync();
	const before = engine.calls.reschedule;
	// The rotation switch is the first toggle in the rotation section; drive it
	// by its effect rather than by index.
	const toggles = byClass(panel.el, "lumen-toggle-input");
	for (const input of toggles) {
		input.checked = true;
		input.dispatch("change", {});
		if (store.getState().mode === "rotation") break;
	}
	assert.equal(store.getState().mode, "rotation", "the rotation switch did not take");
	assert.ok(engine.calls.reschedule > before, "the schedule was not re-armed");
	// Enabling rotation adopts the entry the user is looking at, so the picture
	// does not jump on the first tick.
	assert.equal(store.getState().single.ref, "aurora");
	panel.destroy();
});

test("a wallpaper change is confirmed with a toast, and the toast leaves with the panel", () => {
	// "It worked" is the one thing a panel this tall cannot say with a banner at
	// the top: the user is looking at the page, not at the panel.
	const { panel, t } = makePanel();
	const chip = byClass(panel.el, "lumen-chip").find((el) => el.dataset.recipe === "dune");
	assert.ok(chip, "the ember chip was not rendered");
	chip.dispatch("click", {});

	const toast = byClass(panel.el, "lumen-toast");
	assert.equal(toast.length, 1, "setting a wallpaper produced no confirmation");
	assert.ok(toast[0].classList.contains("is-on"), "the confirmation was never shown");
	assert.ok(textOf(toast[0]).indexOf(t("toast.applied")) < 0, "the toast leaked an unformatted template");
	assert.ok(textOf(toast[0]).length > 0, "the confirmation carried no text");

	panel.destroy();
	assert.equal(byClass(panel.el, "lumen-toast").length, 0, "the toast outlived the panel");
});

test("rotation refuses to arm an empty playlist instead of rotating nothing", () => {
	// A rotation over zero entries would tick forever and change nothing. The
	// switch must decline — and say why — rather than persist a broken mode.
	const { panel, store, t } = makePanel();
	assert.equal(store.getState().playlist.length, 0);
	for (const input of byClass(panel.el, "lumen-toggle-input")) {
		input.checked = true;
		input.dispatch("change", {});
	}
	assert.equal(store.getState().mode, "single", "rotation was enabled with nothing to rotate");
	// The refusal is explained rather than being a switch that silently does
	// nothing, which is the behaviour a user would read as a bug.
	assert.ok(textOf(panel.el).indexOf(t("rotation.empty")) >= 0, "the refusal was not explained");
	// ...and the explanation has to follow the user, not sit at the top of the
	// panel out of sight: the message line is sticky for exactly that reason.
	const banner = byClass(panel.el, "lumen-banner");
	assert.equal(banner.length, 1, "the panel has no banner to report through");
	assert.notEqual(banner[0].style.display, "none", "the banner reported itself as hidden");
	assert.ok(textOf(banner[0]).indexOf(t("rotation.empty")) >= 0, "the banner did not carry the refusal");
	// The empty state sits under the switch itself, so it is the one piece of
	// feedback that is on screen no matter where the panel is scrolled.
	const empty = byClass(panel.el, "lumen-empty-state");
	assert.equal(empty.length, 1, "the empty state was not rendered");
	assert.ok(empty[0].classList.contains("is-refused"), "the refused switch left no mark next to itself");
	panel.destroy();
});

test("an empty playlist offers a one-click fill with the built-in wallpapers", () => {
	// The refusal above is correct but a dead end on its own: the user asked for
	// rotation and got told to go find wallpapers. One button in the empty state
	// turns it into a working rotation over the plugin's own designs.
	const { panel, store, engine, t } = makePanel();
	store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "dune" };
		return draft;
	});
	const button = walk(panel.el).find((el) => el.nodeType === 1 && el.tagName === "BUTTON" && textOf(el) === t("rotation.seed"));
	assert.ok(button, "the empty state did not offer a fill button");

	const before = engine.calls.reschedule;
	button.dispatch("click", {});

	const state = store.getState();
	assert.equal(state.playlist.length, RECIPES.length, "the fill did not add every built-in");
	assert.equal(state.mode, "rotation", "the fill did not arm the rotation");
	assert.ok(engine.calls.reschedule > before, "the schedule was not re-armed");
	// The wallpaper the user was looking at is not replaced in `single`: turning
	// the rotation back off has to return it.
	assert.equal(state.single.ref, "dune", "the fill overwrote the single wallpaper");
	// The rows are deletable, so the fill is an offer rather than a lock-in.
	assert.equal(byClass(panel.el, "lumen-list-item").length, RECIPES.length);
	panel.destroy();
});

test("the playlist renders one row per entry and an empty state when there is none", () => {
	const { panel, store } = makePanel();
	assert.equal(byClass(panel.el, "lumen-list-item").length, 0);
	const empty = byClass(panel.el, "lumen-empty");
	assert.equal(empty.length, 1, "the empty state was not rendered");
	assert.ok(textOf(empty[0]).length > 0, "the empty state has no text");

	store.update((draft) => {
		draft.playlist = [
			{ id: "a1", kind: "recipe", ref: "aurora", seed: "s1" },
			{ id: "b2", kind: "gradient", ref: "linear-gradient(90deg, #000 0%, #fff 100%)", seed: "default" }
		];
		draft.mode = "rotation";
		return draft;
	});
	panel.sync();
	assert.equal(byClass(panel.el, "lumen-list-item").length, 2, "the playlist did not render both entries");
	// The index numbers must match the order the rotation will actually walk.
	const indices = byClass(panel.el, "lumen-list-index").map((el) => el.textContent);
	assert.deepEqual(indices, ["1", "2"]);
	panel.destroy();
});

test("removing a playlist entry is applied to the store", () => {
	const { panel, store } = makePanel();
	store.update((draft) => {
		draft.playlist = [
			{ id: "a1", kind: "recipe", ref: "aurora", seed: "s1" },
			{ id: "b2", kind: "recipe", ref: "dune", seed: "s2" }
		];
		draft.mode = "rotation";
		return draft;
	});
	panel.sync();
	const rowButtons = (index) =>
		byClass(byClass(panel.el, "lumen-list-item")[index], "lumen-btn");
	assert.equal(byClass(panel.el, "lumen-list-item").length, 2);
	// Row controls are ordered: up, down, remove.
	const remove = rowButtons(0)[2];
	assert.equal(remove.textContent, "×");
	remove.click();
	assert.equal(store.getState().playlist.length, 1);
	assert.equal(store.getState().playlist[0].id, "b2", "the wrong entry was removed");
	panel.destroy();
});

test("reordering a playlist entry moves it and keeps the cursor sensible", () => {
	const { panel, store } = makePanel();
	store.update((draft) => {
		draft.playlist = [
			{ id: "a1", kind: "recipe", ref: "aurora", seed: "s1" },
			{ id: "b2", kind: "recipe", ref: "dune", seed: "s2" },
			{ id: "c3", kind: "recipe", ref: "aurora", seed: "s3" }
		];
		draft.mode = "rotation";
		draft.cursor = 1;
		return draft;
	});
	panel.sync();
	const moveUp = byClass(byClass(panel.el, "lumen-list-item")[2], "lumen-btn")[0];
	moveUp.click();
	const ids = store.getState().playlist.map((item) => item.id);
	assert.deepEqual(ids, ["a1", "c3", "b2"], "the entry did not move up by one");
	// The cursor should still point at the entry the user was looking at.
	assert.equal(store.getState().playlist[store.getState().cursor].id, "b2", "the cursor lost track of the current entry");
	panel.destroy();
});

test("the pause control only appears useful when there is a rotation", () => {
	const { panel, store } = makePanel();
	const pause = () => byClass(panel.el, "lumen-btn").find((el) => el.textContent === "暂停" || el.textContent === "继续" || el.textContent === "Pause" || el.textContent === "Resume");
	// Fixed mode: the control is shown but disabled, because there is no clock.
	assert.ok(pause(), "the pause control was not rendered");
	assert.equal(pause().disabled, true, "pausing a fixed wallpaper is meaningless and should be disabled");

	store.update((draft) => {
		draft.playlist = [{ id: "r1", kind: "recipe", ref: "aurora", seed: "s1" }];
		draft.mode = "rotation";
		return draft;
	});
	panel.sync();
	assert.equal(pause().disabled, false, "the pause control should be usable during a rotation");
	pause().click();
	assert.equal(store.getState().paused, true, "pausing did not take");
	panel.sync();
	pause().click();
	assert.equal(store.getState().paused, false, "resuming did not take");
	panel.destroy();
});

test("a schedule change re-arms the timer and is persisted", () => {
	const { panel, store, engine } = makePanel();
	store.update((draft) => {
		draft.playlist = [{ id: "r1", kind: "recipe", ref: "aurora", seed: "s1" }];
		draft.mode = "rotation";
		return draft;
	});
	panel.sync();
	const before = engine.calls.reschedule;
	// The order control is a segmented control whose buttons carry the order.
	const orderButtons = byClass(panel.el, "lumen-seg").filter((el) => {
		const value = el.dataset.value;
		return value === "sequential" || value === "shuffle" || value === "random";
	});
	assert.ok(orderButtons.length >= 3, "the order control did not render its options");
	const shuffle = orderButtons.find((el) => el.dataset.value === "shuffle");
	shuffle.click();
	assert.equal(store.getState().schedule.order, "shuffle");
	assert.ok(engine.calls.reschedule > before, "the timer was not re-armed after an order change");
	panel.destroy();
});

test("the visibility slider moves in the direction its label promises", () => {
	// The control used to expose the VEIL, so dragging it right made the
	// wallpaper fainter while the readout went up. A user looking at a barely
	// visible wallpaper parked it at 0.98 — the maximum — and reported "it is
	// still too faint". Whatever the number means, right must mean more picture.
	const { panel, store, t } = makePanel();
	const input = byClass(panel.el, "lumen-slider-input").find(
		(el) => el.getAttribute("aria-label") === t("appearance.opacity")
	);
	assert.ok(input, "the appearance slider is missing");
	const veil = () => store.getState().wash.opacity;

	input.value = "0.8";
	input.dispatch("input", {});
	const thin = veil();
	input.value = "0.1";
	input.dispatch("input", {});
	const thick = veil();
	assert.ok(thin < thick, `moving the slider right should show more wallpaper, not less: 80% gave veil ${thin}, 10% gave ${thick}`);
	assert.equal(Math.round(thin * 100), 20, "80% visibility did not become a 20% veil");
	panel.destroy();
});

test("out-of-range schedule input is normalised before it reaches the store", () => {
	const { panel, store } = makePanel();
	// A hand-edited or clamped input must never persist a value the scheduler
	// would then treat as a trigger.
	const sliders = byClass(panel.el, "lumen-slider-input");
	assert.ok(sliders.length > 0);
	for (const slider of sliders) {
		slider.value = "999999";
		slider.dispatch("input", {});
	}
	const schedule = store.getState().schedule;
	assert.ok(schedule.intervalMin >= 1, `intervalMin was ${schedule.intervalMin}`);
	assert.ok(schedule.transitionMs >= 0);
	for (const minute of schedule.atMinutes) {
		assert.ok(minute >= 0 && minute <= 59, `atMinutes contained ${minute}`);
	}
	panel.destroy();
});

test("the panel follows the store rather than owning a copy", () => {
	const { panel, store } = makePanel();
	store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "aurora", seed: "s9" };
		return draft;
	});
	// No explicit sync: the panel subscribes.
	const heroSub = byClass(panel.el, "lumen-hero-sub")[0];
	assert.equal(textOf(heroSub).indexOf("s9") >= 0, true, `the hero did not follow the store: ${textOf(heroSub)}`);
	panel.destroy();
});

test("destroy detaches: later store changes do not touch the dead tree", () => {
	const { panel, store } = makePanel();
	const heroSub = byClass(panel.el, "lumen-hero-sub")[0];
	const frozen = textOf(heroSub);
	panel.destroy();
	store.update((draft) => {
		draft.single = { ...draft.single, seed: "after-destroy" };
		return draft;
	});
	assert.equal(textOf(heroSub), frozen, "the panel kept syncing after destroy");
});

test("the diagnostics block reports a degraded persistence channel", async () => {
	// `hostAvailable` starts optimistic and is only falsified by `load()`, so the
	// panel has to be built after the load resolves — which is exactly the order
	// the plugin uses (`store.load().then(() => engine.start())`).
	const document = createDocument();
	const win = createWindow(document);
	g.document = document;
	const store = createStore({ apiPath: "/lumen/api", storage: createStorage(), fetchImpl: null });
	await store.load();
	assert.equal(store.getHealth().hostAvailable, false);
	assert.equal(store.getHealth().hostReason, "no-fetch");

	const engine = createEngineStub();
	const t = createTranslator("zh");
	const panel = createPanel({ store, engine, t, lang: "zh", window: win, document });
	const text = textOf(panel.el);
	// The degradation is disclosed, not hidden behind a promise that settings are
	// being saved to disk.
	assert.ok(text.indexOf(t("status.storage.local")) >= 0, `the degraded mode was not disclosed: ${text}`);
	assert.ok(text.indexOf(t("status.reason")) >= 0, "the reason was not shown");
	assert.ok(text.indexOf("no-fetch") >= 0, "the specific reason was not shown");
	panel.destroy();
});

test("itemLabel names each kind of entry in both languages", () => {
	assert.equal(itemLabel({ kind: "recipe", ref: "aurora", seed: "default" }, "zh"), "极光");
	assert.equal(itemLabel({ kind: "recipe", ref: "aurora", seed: "default" }, "en"), "Aurora");
	assert.equal(itemLabel({ kind: "recipe", ref: "aurora", seed: "s3" }, "en"), "Aurora · s3");
	assert.equal(itemLabel({ kind: "url", ref: "https://cdn.example.com/a.jpg", seed: "default" }, "en"), "cdn.example.com");
	assert.equal(itemLabel({ kind: "gradient", ref: "linear-gradient(#000 0%, #fff 100%)", seed: "default" }, "en"), "Gradient");
	assert.equal(itemLabel({ kind: "gradient", ref: "linear-gradient(#000 0%, #fff 100%)", seed: "default" }, "zh"), "渐变");
	assert.ok(itemLabel({ kind: "image", ref: "x".repeat(2048), seed: "default" }, "en").indexOf("KB") >= 0);
	assert.equal(itemLabel(null, "en"), "");
	// An unknown recipe id must not render as blank.
	assert.equal(itemLabel({ kind: "recipe", ref: "no-such-recipe", seed: "default" }, "en"), "no-such-recipe");
});

test("formatDuration reads as a duration at every scale", () => {
	assert.equal(formatDuration(0), "0 秒");
	assert.equal(formatDuration(1500), "2 秒");
	assert.equal(formatDuration(90000), "1 分 30 秒");
	assert.equal(formatDuration(3600000), "1 小时 00 分");
	assert.equal(formatDuration(-5000), "0 秒", "a negative remaining time must not render as a minus");
});

test("formatClockStamp distinguishes today from a later date", () => {
	const now = new Date(2026, 2, 18, 9, 0, 0).getTime();
	const today = new Date(2026, 2, 18, 13, 5, 0).getTime();
	const tomorrow = new Date(2026, 2, 19, 7, 30, 0).getTime();
	assert.equal(formatClockStamp(today, now), "13:05");
	assert.equal(formatClockStamp(tomorrow, now), "03/19 07:30");
});

test("the panel's translation namespace is the settings-scoped one", () => {
	// The host looks the dictionary up under this namespace; a mismatch shows up
	// as raw keys in the UI.
	assert.equal(NS, "settings.lumen");
});

/**
 * The transient message banner.
 *
 * It is deliberately the panel's first child — a message about the thing you
 * just did belongs above the thing you just did — so it is located by position
 * and then asserted to actually be the banner. The class check is what keeps
 * this from silently reading some other node the day the assembly is reordered.
 */
function bannerOf(panel) {
	const node = panel.el.childNodes[0];
	assert.ok(node && node.nodeType === 1 && node.classList.contains("lumen-note"), "the banner is no longer the panel's first child");
	return node;
}

/** A successful decode, shaped the way `applyImported` consumes it. */
function decodedPhoto() {
	return { dataUrl: "data:image/png;base64,AAAA", width: 1920, height: 1080, bytes: 40960, luminance: 0.5 };
}

// ── the splash section ──────────────────────────────────────────────────────
//
// The section is optional by construction: a host that never registers the
// splash routes must still get a working panel, and the way to prove that is
// to build one without the channel and check the section is simply absent
// rather than broken or half-rendered.

test("the splash section exists only when the host offers a channel", () => {
	const without = makePanel();
	assert.equal(textOf(without.panel.el).indexOf(without.t("splash.local")), -1, "the splash section rendered with no splash channel");
	assert.equal(
		walk(without.panel.el).filter((el) => el.getAttribute && el.getAttribute("accept") === "image/*,video/*").length,
		0,
		"a splash picker was rendered with no splash channel"
	);
	without.panel.destroy();

	const withChannel = makePanel({ splash: createSplashStub() });
	assert.ok(textOf(withChannel.panel.el).indexOf(withChannel.t("splash.local")) >= 0, "the splash section is missing");
	// The picker must advertise clips, not just pictures — a picker offering
	// `image/*` alone would look correct in a screenshot and silently hide half
	// the feature.
	assert.equal(splashPickerOf(withChannel.panel).getAttribute("accept"), "image/*,video/*");
	// Single-select: the host stores one name, so offering a multi-select would
	// promise something the other end cannot honour.
	assert.equal(splashPickerOf(withChannel.panel).getAttribute("multiple"), null, "the splash picker allows multiple files");
	withChannel.panel.destroy();
});

test("the splash section translates in both languages", () => {
	// The general hardcoded-text test builds a panel with no splash channel, so
	// the splash labels would slip through it entirely.
	const pairs = [];
	for (const lang of ["zh", "en"]) {
		const built = makePanel({ lang, splash: createSplashStub() });
		pairs.push({ lang, text: textOf(built.panel.el) });
		built.panel.destroy();
	}
	const [zh, en] = pairs;
	assert.ok(zh.text.indexOf("开屏") >= 0, "the Chinese panel did not render the splash section");
	assert.equal(/[\u4e00-\u9fff]/.test(en.text), false, "the English panel leaked untranslated Chinese from the splash section");
});

test("the status line reports what the host says, and admits when it cannot ask", async () => {
	const configured = makePanel({ splash: createSplashStub({ probe: { configured: true, kind: "video", bytes: 20480 } }) });
	await flush();
	const statusText = () => {
		const notes = walk(configured.panel.el).filter((el) => el.nodeType === 1 && el.classList.contains("lumen-note"));
		return notes.map(textOf).join("\n");
	};
	assert.ok(statusText().indexOf(configured.t("splash.current.video")) >= 0, "the clip splash was not reported");
	assert.ok(statusText().indexOf("20KB") >= 0, "the size was not reported");
	configured.panel.destroy();

	const absent = makePanel({ splash: createSplashStub({ probe: { configured: false, kind: null, bytes: 0 } }) });
	await flush();
	assert.ok(textOf(absent.panel.el).indexOf(absent.t("splash.none")) >= 0, "an unset splash was not reported as unset");
	absent.panel.destroy();
});

test("an unreachable host route is admitted rather than shown as 'not set'", async () => {
	// "Not set" and "cannot tell" are different answers. Collapsing them would
	// tell the user their splash is gone when the truth is that the question
	// could not be asked.
	const { panel, t } = makePanel({
		splash: createSplashStub({
			probe: () => {
				throw new Error("offline");
			}
		})
	});
	await flush();
	const text = textOf(panel.el);
	assert.ok(text.indexOf(t("splash.unknown")) >= 0, "the unreachable route was not disclosed");
	assert.equal(text.indexOf(t("splash.none")), -1, "an unreachable route was reported as 'not set'");
	panel.destroy();
});

test("a clip is offered exactly one destination, and a picture three", () => {
	const built = makePanel({ splash: createSplashStub() });

	chooseSplash(built.panel, [splashFile("clip.mp4", "video/mp4")]);
	assert.deepEqual(targetNames(built.panel, built.t), ["splash"], "a clip was offered a destination that cannot exist");

	chooseSplash(built.panel, [splashFile("photo.png", "image/png")]);
	assert.deepEqual(targetNames(built.panel, built.t), ["wallpaper", "splash", "both"], "a picture was not offered all three destinations");
	built.panel.destroy();
});

test("an unsupported type is refused before the host is ever asked", () => {
	const stub = createSplashStub();
	const { panel, t } = makePanel({ splash: stub });
	chooseSplash(panel, [splashFile("notes.txt", "text/plain")]);
	assert.equal(stub.calls.upload.length, 0, "an unsupported file reached the host");
	assert.deepEqual(targetNames(panel, t), [], "an unsupported file offered destinations");
	assert.ok(textOf(panel.el).indexOf(t("splash.error.unsupported")) >= 0, "the refusal was not explained");
	panel.destroy();
});

test("a batch is trimmed to one file, and the panel says so instead of dropping the rest", () => {
	const stub = createSplashStub();
	const { panel, t } = makePanel({ splash: stub });
	chooseSplash(panel, [splashFile("one.png", "image/png", 1024), splashFile("two.png", "image/png", 2048)]);
	assert.ok(textOf(panel.el).indexOf(t("splash.oneAtATime")) >= 0, "the extra files were discarded silently");
	assert.deepEqual(targetNames(panel, t), ["wallpaper", "splash", "both"], "the first file was not the one staged");
	panel.destroy();
});

test("setting a splash uploads the file and warns that a reload is what shows it", async () => {
	const stub = createSplashStub();
	const { panel, t } = makePanel({ splash: stub });
	const file = splashFile("art.png", "image/png", 4096);
	chooseSplash(panel, [file]);
	clickTarget(panel, t, "splash");
	await flush();

	assert.equal(stub.calls.upload.length, 1, "the host was not asked to store the splash");
	assert.equal(stub.calls.upload[0], file, "the wrong file was uploaded");
	// The sentence carries the part a user cannot see: the cover is read when the
	// document is generated, so what they just set is not in the page they are
	// looking at. Without that, a working feature reads as a broken one.
	assert.equal(textOf(bannerOf(panel)), t("splash.stored", { kb: 4 }), "the deferred-reload warning was not shown");
	assert.equal(bannerOf(panel).classList.contains("is-warn"), false, "a success was reported as a warning");
	assert.deepEqual(targetNames(panel, t), [], "the staged file was not cleared after it was applied");
	panel.destroy();
});

test("setting both writes the wallpaper and the splash in one gesture", async () => {
	const stub = createSplashStub();
	const { panel, t, store } = makePanel({ splash: stub, decode: decodedPhoto });
	chooseSplash(panel, [splashFile("both.png", "image/png", 4096)]);
	clickTarget(panel, t, "both");
	await flush();

	assert.equal(stub.calls.upload.length, 1, "the splash half was skipped");
	assert.equal(store.getState().single.kind, "image", "the wallpaper half was skipped");
	assert.equal(textOf(bannerOf(panel)), t("splash.storedBoth", { kb: 4 }), "the combined result was not reported");
	panel.destroy();
});

test("a failed wallpaper half is disclosed rather than hidden behind the splash success", async () => {
	// The decoder throws, so the picture never becomes a wallpaper. Reporting
	// "set as both" here would be the panel taking credit for half a job it did
	// not do — and the wallpaper is the half the user would notice missing.
	const stub = createSplashStub();
	const { panel, t, store } = makePanel({ splash: stub });
	chooseSplash(panel, [splashFile("both.png", "image/png", 4096)]);
	clickTarget(panel, t, "both");
	await flush();

	assert.equal(stub.calls.upload.length, 1, "the splash half should still have run");
	assert.equal(store.getState().single.kind, "recipe", "the wallpaper half unexpectedly succeeded");
	assert.equal(textOf(bannerOf(panel)), t("splash.wallpaperFailed", { kb: 4 }), "the half-done job was not disclosed");
	assert.equal(bannerOf(panel).classList.contains("is-warn"), true, "a half-done job was reported as a success");
	panel.destroy();
});

test("a failed upload is reported with the reason the host gave, and the file is kept", async () => {
	const stub = createSplashStub({ upload: () => ({ ok: false, reason: "payload-too-large" }) });
	const { panel, t } = makePanel({ splash: stub });
	chooseSplash(panel, [splashFile("huge.png", "image/png", 4096)]);
	clickTarget(panel, t, "splash");
	await flush();

	assert.equal(textOf(bannerOf(panel)), t("splash.error.tooLarge"), "the host's reason was not passed through");
	assert.equal(bannerOf(panel).classList.contains("is-warn"), true, "a failure was reported as a success");
	// Keeping the staged file is the whole point: the user can try a different
	// destination without picking the file again.
	assert.deepEqual(targetNames(panel, t), ["wallpaper", "splash", "both"], "the staged file was cleared despite the failure");
	panel.destroy();
});

test("clearing reports which of the two outcomes actually happened", async () => {
	const cases = [
		[{ ok: true, cleared: true }, "splash.cleared"],
		[{ ok: true, cleared: false }, "splash.nothingToClear"]
	];
	for (const [answer, key] of cases) {
		const built = makePanel({ splash: createSplashStub({ clear: answer }) });
		const clearBtn = walk(built.panel.el).find((el) => el.nodeType === 1 && el.tagName === "BUTTON" && textOf(el) === built.t("splash.clear"));
		assert.ok(clearBtn, "the clear button was not rendered");
		clearBtn.dispatch("click", {});
		await flush();
		assert.equal(textOf(bannerOf(built.panel)), built.t(key), `clearing did not report ${key}`);
		built.panel.destroy();
	}

	const failing = makePanel({ splash: createSplashStub({ clear: { ok: false, reason: "no-host" } }) });
	const btn = walk(failing.panel.el).find((el) => el.nodeType === 1 && el.tagName === "BUTTON" && textOf(el) === failing.t("splash.clear"));
	btn.dispatch("click", {});
	await flush();
	assert.equal(textOf(bannerOf(failing.panel)), failing.t("splash.error.noHost"), "a failed clear was not reported");
	failing.panel.destroy();
});
