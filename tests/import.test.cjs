"use strict";
/**
 * The import path: multi-select, drag-and-drop, the batch semantics of
 * installing several pictures at once, and the position grid.
 *
 * WHY `prepareImage` IS STUBBED HERE
 *
 * `image.test.cjs` already covers the decoder against a canvas double — the
 * downscale loop, the alpha policy, the measurement. What is untested there and
 * lives here is the PANEL's handling of a batch: that five files become one
 * state write rather than five, that the first picture is the one shown, that a
 * single bad file does not discard the other four, and that a measurement
 * survives the trip into the store. None of that needs real pixels, and driving
 * the real decoder would mean a canvas double per test that says nothing about
 * the behaviour under test.
 *
 * The stub is installed BEFORE `ui/panel.cjs` is required, because that module
 * destructures `prepareImage` at load time — patching afterwards would edit a
 * property nobody reads.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { MiniElement, MiniText, createDocument, createWindow, createStorage } = require("./helpers/minidom.cjs");

const g = globalThis;
g.document = createDocument();
g.HTMLElement = MiniElement;
g.Node = MiniElement;
g.Text = MiniText;

// ── the decoder stub, installed before the panel is loaded ──────────────────

const image = require("../src/image.cjs");
/** Swapped per test; returns the `prepareImage` result shape. */
let decodePlan = null;
const decodeLog = [];
image.prepareImage = async (file) => {
	decodeLog.push(file.name);
	if (decodePlan === null) throw new Error("decode-failed");
	return decodePlan(file);
};

const dom = require("../src/ui/dom.cjs");
const { createPanel } = require("../src/ui/panel.cjs");
const { createStore } = require("../src/store.cjs");
const { createTranslator } = require("../src/i18n.cjs");
const { WASH_POSITIONS, MAX_PLAYLIST } = require("../src/state.cjs");

/**
 * The nine cells in reading order, as the panel lays them out.
 *
 * Duplicated from `ui/panel.cjs` on purpose: `grid9` takes an order, so a test
 * at this level has to supply one. Keeping it separate is also what makes the
 * drift check meaningful — a copy taken from the module under test could not
 * catch the module having the wrong order.
 */
const READING_ORDER = [
	"top left",
	"top",
	"top right",
	"left",
	"center",
	"right",
	"bottom left",
	"bottom",
	"bottom right"
];

// ── harness ─────────────────────────────────────────────────────────────────

function walk(node, out) {
	const found = out || [];
	found.push(node);
	for (const child of node.childNodes || []) walk(child, found);
	return found;
}

/** Elements in a subtree carrying a class (the subtree root included). */
function byClass(root, name) {
	return walk(root).filter((el) => el.nodeType === 1 && el.classList.contains(name));
}

function textOf(node) {
	return node.textContent === null || node.textContent === undefined ? "" : String(node.textContent);
}

function createEngineStub() {
	return {
		render: () => {},
		reschedule: () => {},
		setRequirement: () => {},
		setMissed: () => {},
		inspect: () => ({ requiredAlpha: 0, plan: { missed: 0 }, hasDom: true, active: true })
	};
}

function makePanel(options) {
	const opts = options || {};
	const document = createDocument();
	const win = createWindow(document);
	g.document = document;
	const store = createStore({ apiPath: "/lumen/api", storage: createStorage(), fetchImpl: null });
	const t = createTranslator(opts.lang === "en" ? "en" : "zh");
	const panel = createPanel({ store, engine: createEngineStub(), t, lang: opts.lang, window: win, document });
	return { document, win, store, panel, t };
}

/** A `File`-shaped object — the decoder is stubbed, so only the fields read matter. */
function fakeFile(name, type) {
	return { name, type: type || "image/png", size: 2048 };
}

/** The hidden `<input type=file>` the "choose" button clicks. */
function pickerOf(panel) {
	const found = byClass(panel.el, "lumen-file-input");
	assert.equal(found.length, 1, "the panel should expose exactly one file picker");
	return found[0];
}

/** Hand a batch to the panel the way the picker does. */
function choose(panel, files) {
	const picker = pickerOf(panel);
	picker.files = files;
	picker.dispatch("change", {});
	return picker;
}

/** The row that accepts dropped files. */
function dropRowOf(panel) {
	const rows = walk(panel.el).filter((el) => el.listeners && el.listeners.drop);
	assert.equal(rows.length, 1, "exactly one element should accept drops");
	return rows[0];
}

/** A `drop` event carrying files. */
function dropEvent(files) {
	return {
		preventDefault: () => {},
		dataTransfer: { files, dropEffect: "" }
	};
}

/** A successful decode of a 1x1 picture with a given brightness. */
function decoded(luminance, dataUrl) {
	return {
		dataUrl: dataUrl || `data:image/png;base64,aW1n${Math.round(luminance * 1000)}`,
		width: 1920,
		height: 1080,
		bytes: 40960,
		luminance
	};
}

/** Reset the stub between tests. */
function resetDecode() {
	decodeLog.length = 0;
	decodePlan = null;
}

// ── the DOM helpers ─────────────────────────────────────────────────────────

test("the file picker is multiple and always reports an array", () => {
	const seen = [];
	const picker = dom.filePicker("image/*", (files) => seen.push(files));
	// A boolean attribute is present-or-absent, not `="true"`.
	assert.notEqual(picker.getAttribute("multiple"), null, "the picker is not multiple");

	// One file still arrives as an array — the caller has one shape to write
	// against rather than two.
	picker.files = [fakeFile("one.png")];
	picker.dispatch("change", {});
	assert.equal(seen.length, 1);
	assert.ok(Array.isArray(seen[0]), "a single file was not wrapped in an array");

	picker.files = [fakeFile("two.png"), fakeFile("three.jpg", "image/jpeg")];
	picker.dispatch("change", {});
	assert.equal(seen[1].length, 2);

	// Re-picking the same file must fire again, which it will not while the
	// input still holds it.
	assert.equal(picker.value, "", "the picker did not clear itself");

	// An empty selection says nothing rather than reporting an empty batch.
	picker.files = [];
	picker.dispatch("change", {});
	assert.equal(seen.length, 2);
});

test("a drop reports its files and clears the highlight", () => {
	const seen = [];
	const host = new MiniElement("div");
	dom.acceptDrops(host, (files) => seen.push(files));
	host.dispatch("dragenter", { preventDefault: () => {} });
	assert.ok(host.classList.contains("is-drop"), "the drop target was not highlighted");
	host.dispatch("drop", dropEvent([fakeFile("a.png")]));
	assert.equal(seen.length, 1);
	assert.equal(seen[0].length, 1);
	assert.equal(host.classList.contains("is-drop"), false, "the highlight survived the drop");
});

test("the drop highlight is counted, not toggled", () => {
	// `dragleave` fires every time the pointer crosses into a CHILD, so a naive
	// enter-add/leave-remove pair flickers the highlight off and on while the
	// pointer is still inside the target.
	const host = new MiniElement("div");
	dom.acceptDrops(host, () => {});
	const enter = { preventDefault: () => {} };
	host.dispatch("dragenter", enter); // the row
	host.dispatch("dragenter", enter); // a label inside it
	host.dispatch("dragleave", {}); // still inside, moving between children
	assert.ok(host.classList.contains("is-drop"), "the highlight flickered off while the pointer was still inside");
	host.dispatch("dragleave", {});
	assert.equal(host.classList.contains("is-drop"), false, "the highlight did not clear on the final leave");
});

test("a drag over the target advertises the drop as a copy", () => {
	// Without an explicit `dropEffect` the browser reports "no drop allowed" and
	// the drop never fires at all.
	const host = new MiniElement("div");
	let prevented = 0;
	dom.acceptDrops(host, () => {});
	const event = { preventDefault: () => { prevented += 1; }, dataTransfer: { dropEffect: "" } };
	host.dispatch("dragover", event);
	assert.equal(prevented, 1, "the default drag-over behaviour was not suppressed");
	assert.equal(event.dataTransfer.dropEffect, "copy");
});

test("the drop listener set can be torn down", () => {
	// A caller that rebuilds its subtree would otherwise leave handlers pointing
	// at detached nodes.
	const seen = [];
	const host = new MiniElement("div");
	const teardown = dom.acceptDrops(host, () => seen.push(1));
	teardown();
	host.dispatch("drop", dropEvent([fakeFile("a.png")]));
	assert.equal(seen.length, 0, "the teardown did not detach the handlers");
	assert.equal(typeof teardown, "function", "acceptDrops must return a teardown");
});

test("the position grid is three by three, in reading order, with one cell on", () => {
	// The order handed in is the order that must come out: `grid9` is a layout,
	// so a cell that arrived third has to land third or the picture moves the
	// wrong way when the user clicks it.
	const changes = [];
	const control = dom.grid9({
		label: "position",
		value: "center",
		cells: READING_ORDER.map((value) => ({ value, hint: value })),
		onChange: (value) => changes.push(value)
	});
	const cells = byClass(control.el, "lumen-grid9-cell");
	assert.equal(cells.length, 9);
	assert.equal(control.el.getAttribute("role"), "group");
	assert.equal(control.el.getAttribute("aria-label"), "position");

	// Row by row, left to right.
	const order = cells.map((cell) => cell.dataset.value);
	assert.deepEqual(order, READING_ORDER, "the grid did not preserve reading order");
	assert.deepEqual(order.slice(0, 3), ["top left", "top", "top right"], "the first row is not the top row");
	assert.equal(new Set(order).size, 9, "two cells carry the same position");

	// A grid of buttons is a toggle group, so the state has to be on the buttons
	// too — the `is-on` class alone is invisible to a screen reader.
	const on = cells.filter((cell) => cell.getAttribute("aria-pressed") === "true");
	assert.equal(on.length, 1, `${on.length} cells report themselves as pressed`);
	assert.equal(on[0].dataset.value, "center");

	cells[0].click();
	assert.deepEqual(changes, ["top left"], "clicking a cell did not report its position");
	assert.equal(cells[0].getAttribute("aria-pressed"), "true");
	assert.equal(cells[4].getAttribute("aria-pressed"), "false", "the previous cell stayed pressed");

	// `set` is what lets the panel follow an external state change.
	control.set("bottom right");
	assert.equal(cells[8].getAttribute("aria-pressed"), "true");
	assert.equal(byClass(control.el, "lumen-grid9-cell").filter((c) => c.getAttribute("aria-pressed") === "true").length, 1);
});

test("every position the state accepts is reachable in the grid", () => {
	// The grid order is written by hand (a 3x3 is a layout, not a set) while the
	// predicate is derived from `WASH_POSITIONS`. Pinning them together is what
	// stops a position being added to the state and never becoming clickable.
	const { panel } = makePanel();
	const cells = byClass(panel.el, "lumen-grid9-cell").map((cell) => cell.dataset.value);
	assert.deepEqual([...cells].sort(), [...WASH_POSITIONS].sort(), "the grid and WASH_POSITIONS have drifted apart");
	panel.destroy();
});

// ── the panel's position control ────────────────────────────────────────────

test("clicking a position cell writes it through to the store and repaints", () => {
	const { panel, store } = makePanel();
	const cells = byClass(panel.el, "lumen-grid9-cell");
	const target = cells.find((cell) => cell.dataset.value === "left");
	target.click();
	assert.equal(store.getState().wash.position, "left");
	assert.equal(store.getState().washTouched, true, "moving the picture is a deliberate appearance choice");
	panel.destroy();
});

test("the grid follows an external position change rather than owning it", () => {
	const { panel, store } = makePanel();
	store.update((draft) => {
		draft.wash = { ...draft.wash, position: "top right" };
		return draft;
	});
	const pressed = byClass(panel.el, "lumen-grid9-cell").filter((cell) => cell.getAttribute("aria-pressed") === "true");
	assert.equal(pressed.length, 1);
	assert.equal(pressed[0].dataset.value, "top right");
	panel.destroy();
});

// ── importing a batch ───────────────────────────────────────────────────────

test("a batch of pictures becomes one shown and the rest queued, in one write", async () => {
	resetDecode();
	const { panel, store } = makePanel();
	decodePlan = (file) => decoded(Number(file.name.replace(/\D/g, "")) / 100);

	let writes = 0;
	const unsubscribe = store.subscribe(() => {
		writes += 1;
	});
	choose(panel, [fakeFile("10.png"), fakeFile("20.png"), fakeFile("30.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	unsubscribe();

	const state = store.getState();
	// The first picture is the one the user judges the import by, so it is what
	// ends up on screen; the rest are candidates the rotation can walk.
	assert.equal(state.single.kind, "image");
	assert.equal(decodeLog[0], "10.png", "the decoder ran out of order");
	assert.equal(state.playlist.length, 2);
	assert.equal(state.playlist[0].kind, "image");
	assert.equal(state.playlist[1].kind, "image");
	assert.equal(writes, 1, `the batch took ${writes} state writes, not one`);
	assert.equal(decodeLog.length, 3, "not every picture was decoded");
	panel.destroy();
});

test("the measured brightness rides into the store, one value per picture", async () => {
	resetDecode();
	const { panel, store } = makePanel();
	decodePlan = (file) => decoded(Number(file.name.replace(/\D/g, "")) / 100);
	choose(panel, [fakeFile("84.png"), fakeFile("03.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const state = store.getState();
	assert.equal(state.single.luminance, 0.84, "the single's measurement was lost");
	assert.equal(state.playlist[0].luminance, 0.03, "the queued entry's measurement was lost");
	panel.destroy();
});

test("one unreadable file does not discard the rest of the batch", async () => {
	resetDecode();
	const { panel, store, t } = makePanel();
	decodePlan = (file) => {
		if (file.name === "bad.png") throw new Error("decode-failed");
		return decoded(0.5);
	};
	choose(panel, [fakeFile("one.png"), fakeFile("bad.png"), fakeFile("three.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const state = store.getState();
	assert.equal(state.single.kind, "image", "a failure aborted the batch");
	assert.equal(state.playlist.length, 1, "the surviving picture was not queued");
	// And the loss is disclosed rather than silent.
	const text = textOf(panel.el);
	assert.ok(text.indexOf(t("custom.importPartial", { ok: 2, failed: 1 })) >= 0, `the partial failure was not reported: ${text}`);
	panel.destroy();
});

test("a batch where nothing decoded installs nothing and says why", async () => {
	resetDecode();
	const { panel, store, t } = makePanel();
	decodePlan = () => {
		throw new Error("still-too-large");
	};
	const before = store.getState().single;
	choose(panel, [fakeFile("huge.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(store.getState().single, before, "a failed import changed what is on screen");
	assert.equal(store.getState().playlist.length, 0);
	assert.ok(textOf(panel.el).indexOf(t("error.stillTooLarge")) >= 0, "the reason was not shown");
	panel.destroy();
});

test("a non-image is refused before it reaches the decoder", async () => {
	resetDecode();
	const { panel, t } = makePanel();
	decodePlan = () => decoded(0.5);
	choose(panel, [fakeFile("notes.txt", "text/plain"), { name: "mystery", size: 10 }]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(decodeLog.length, 0, "a non-image was handed to the decoder");
	assert.ok(textOf(panel.el).indexOf(t("error.notImage")) >= 0, "the refusal was not explained");
	panel.destroy();
});

test("a second batch is ignored while the first is still decoding", async () => {
	// Each decode holds a full-resolution bitmap, so the peak has to be bounded
	// at one picture. A re-entrant batch would run a second decode alongside the
	// first and double it.
	resetDecode();
	const { panel, store } = makePanel();
	let release = null;
	decodePlan = () => new Promise((resolve) => {
		release = () => resolve(decoded(0.5));
	});

	choose(panel, [fakeFile("slow.png")]);
	choose(panel, [fakeFile("also-slow.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(decodeLog.length, 1, `the second batch was not ignored (${decodeLog.join(", ")})`);

	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(store.getState().single.kind, "image");
	panel.destroy();
});

test("a drop installs the pictures exactly as the picker does", async () => {
	resetDecode();
	const { panel, store } = makePanel();
	decodePlan = () => decoded(0.42);
	dropRowOf(panel).dispatch("drop", dropEvent([fakeFile("a.png"), fakeFile("b.png")]));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const state = store.getState();
	assert.equal(state.single.kind, "image");
	assert.equal(state.playlist.length, 1);
	panel.destroy();
});

test("the playlist cap is reported rather than silently swallowing entries", async () => {
	resetDecode();
	const { panel, store, t } = makePanel();
	decodePlan = () => decoded(0.5);
	const files = [];
	for (let i = 0; i < MAX_PLAYLIST + 3; i += 1) files.push(fakeFile(`p${i}.png`));
	choose(panel, files);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const kept = store.getState().playlist.length;
	assert.equal(kept, MAX_PLAYLIST, `the playlist grew to ${kept}`);
	const text = textOf(panel.el);
	assert.ok(text.indexOf(t("custom.importCapped", { n: files.length - 2, cap: MAX_PLAYLIST })) >= 0, `the overflow was not reported: ${text}`);
	panel.destroy();
});

test("an unmeasured picture stays unmeasured rather than defaulting to black", async () => {
	// A `null` luminance is the signal that the readability floor must fall back
	// to the neutral constant. Coercing it to 0 would be pure black, the one
	// value at which the floor stops protecting text.
	resetDecode();
	const { panel, store } = makePanel();
	decodePlan = () => ({ dataUrl: "data:image/png;base64,bm9uZQ==", width: 10, height: 10, bytes: 16, luminance: null });
	choose(panel, [fakeFile("flat.png")]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(store.getState().single.luminance, null);
	panel.destroy();
});
