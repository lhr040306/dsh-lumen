"use strict";
/**
 * The preview, as a test.
 *
 * WHY THE PREVIEW NEEDS A TEST AT ALL
 *
 * The preview is not a screenshot — it *boots the shipped bundle* against a fake
 * platform, and every number on the right-hand side of the page is computed from
 * the plugin's own public surfaces. So when the harness gets something wrong the
 * page does not fail loudly; it shows a confident number that happens to be
 * wrong. Two examples that would otherwise be invisible:
 *
 *   - if the harness's fake `Date` shifted `new Date(ts)` as well as `Date.now()`,
 *     every countdown would read "in 7 days" right after a forward jump, and the
 *     scheduler would look broken rather than the preview;
 *   - if the slots double registered but never rendered, the settings section
 *     would be an empty box and the React bridge would go untested.
 *
 * So this file asserts the things the page claims, in the same realm the page
 * uses: the loader contract, the clock arithmetic, the panel mounting through the
 * real bridge, the "exactly two tokens" promise, the readability floor, the
 * scheduler's catch-up path, teardown, and the preview server's merge rules.
 *
 * The realm is built with `vm.createContext` so that the plugin's `window` *is*
 * the context's global object — which is what makes `window.Date = ShiftedDate`
 * mean here exactly what it means in a browser.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const { createDocument, createWindow, createStorage } = require("./helpers/minidom.cjs");

const ROOT = path.join(__dirname, "..");
const HARNESS = path.join(ROOT, "preview", "harness.js");
const BUNDLE = path.join(ROOT, "lib", "client.js");
const INDEX_HTML = path.join(ROOT, "preview", "index.html");
const BOOT_HTML = path.join(ROOT, "preview", "boot.html");
const BOOT_JS = path.join(ROOT, "preview", "boot.js");
const PREVIEW_JS = path.join(ROOT, "preview", "preview.js");
const SERVE = path.join(ROOT, "scripts", "serve.cjs");
const HOST_MODULE = path.join(ROOT, "lib", "index.js");

/** A backdrop bright enough that light text on the unwashed canvas fails AA. */
const BRIGHT_GRADIENT = "linear-gradient(160deg, #ffffff 0%, #f2f6ff 100%)";

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

/**
 * Build the preview's realm: a context whose global object is also `window`.
 *
 * @param {object} [options]
 * @param {Function} [options.fetch] host-channel double, if any
 */
function createPreview(options) {
	const opts = options || {};
	const document = createDocument();
	const win = createWindow(document);
	const logged = [];

	const sandbox = {};
	// `window` and `self` are the global object, as they are in a browser. That is
	// not cosmetic: `harness.js` assigns `window.Date`, and in the shell that
	// assignment has to change the global `Date` the *plugin* reads.
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.document = document;
	sandbox.navigator = win.navigator;
	sandbox.location = win.location;
	sandbox.console = {
		warn: (...args) => logged.push(args.map(String).join(" ")),
		error: (...args) => logged.push(args.map(String).join(" ")),
		log: () => {}
	};
	sandbox.setTimeout = win.setTimeout;
	sandbox.clearTimeout = win.clearTimeout;
	sandbox.setInterval = win.setInterval;
	sandbox.clearInterval = win.clearInterval;
	sandbox.requestAnimationFrame = win.requestAnimationFrame;
	sandbox.cancelAnimationFrame = win.cancelAnimationFrame;
	sandbox.matchMedia = () => ({ matches: false, addEventListener: () => {} });
	sandbox.localStorage = createStorage();
	sandbox.fetch = opts.fetch;
	sandbox.URL = URL;

	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(HARNESS, "utf8"), sandbox, { filename: HARNESS });
	vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), sandbox, { filename: BUNDLE });

	const preview = sandbox.__DSH_LUMEN_PREVIEW__;
	assert.ok(preview, "the harness did not publish __DSH_LUMEN_PREVIEW__");
	return {
		sandbox,
		document,
		logged,
		preview,
		plugin: preview.module("dsh-lumen"),
		/** The realm's `Date`, i.e. the shifted one the plugin sees. */
		Date: sandbox.Date,
		/** The unshifted clock, which the harness keeps for exactly this comparison. */
		RealDate: preview.RealDate
	};
}

/** Let `store.load()` and the engine's boot settle. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Boot the plugin the way `preview.js` does — create a ctx, apply, then mount the
 * registered section through the registered slot — and hand back a teardown.
 */
async function bootWithPanel(options) {
	const realm = createPreview(options);
	const ctx = realm.preview.createContext();
	if (options && options.lang) ctx.locale.setLanguage(options.lang);
	if (options && options.theme) ctx.theme.setPreference(options.theme);
	ctx.theme.mount(realm.document.documentElement);
	const api = realm.plugin.apply(ctx);
	await settle();

	const container = realm.document.createElement("div");
	realm.document.body.appendChild(container);
	let unmount = () => {};
	const section = ctx.slots.renderSlot("settings.section", {});
	if (section !== null) {
		unmount = realm.preview.renderer.mount(section.type, section.props, container);
		await settle();
	}
	api.__container = container;
	api.__unmount = () => {
		unmount();
		container.parentNode && container.parentNode.removeChild(container);
	};
	return { realm, ctx, api };
}

/** Every element in the document whose class contains a fragment. */
function byClass(document, fragment) {
	return document.documentElement.queryAll((el) => String(el.className).indexOf(fragment) >= 0);
}

/** The alpha the page is actually painting for the canvas token. */
/**
 * The alpha the plugin is actually painting with.
 *
 * It used to be readable from the override token, because the wash wrote
 * `rgba(...)` into `--dsw-alias-bg-base`. It now paints one translucent layer
 * of its own (`data-dsh-lumen="veil"`) and hands the shell transparent
 * surfaces — the token route compounded across nested surfaces and hid the
 * wallpaper — so the veil is where the number lives.
 */
function washAlpha(realm) {
	const doc = realm && realm.document ? realm.document : null;
	if (!doc) return 1;
	const veil = doc.documentElement.queryAll((el) => el.getAttribute("data-dsh-lumen") === "veil")[0];
	if (!veil) return 1;
	const match = String(veil.style.backgroundColor).match(/^rgba?\(([^)]+)\)$/);
	if (match === null) return 1;
	const parts = match[1].split(",").map((part) => Number(part.trim()));
	return parts.length === 4 ? parts[3] : 1;
}

// ── the loader contract ─────────────────────────────────────────────────────

test("the harness loads the shipped bundle through the real loader contract", () => {
	const realm = createPreview();
	assert.deepEqual(Array.from(realm.preview.loadedIds()), ["dsh-lumen"]);
	assert.equal(typeof realm.plugin.apply, "function");
	assert.deepEqual(Array.from(realm.plugin.inject), ["slots", "locale", "theme"]);
	// The preview reads these to describe the current item without reaching in.
	assert.equal(typeof realm.plugin.__modules.scheduler.nextTriggerAt, "function");
	assert.equal(typeof realm.plugin.__modules.state.createItem, "function");
	assert.ok(Array.isArray(realm.plugin.__modules.wallpapers.RECIPE_IDS));
});

// ── the clock shift: the arithmetic the whole demo rests on ─────────────────

test("shifting the clock moves the present and nothing else", () => {
	const realm = createPreview();
	const { preview, Date: Shifted, RealDate } = realm;
	const FIXED = 1_800_000_000_000;

	const realNow = RealDate.now();
	const shiftedNow = Shifted.now();
	assert.ok(Math.abs(shiftedNow - realNow) < 1000, "an unshifted clock must agree with the real one");

	assert.equal(preview.shiftClock(3 * HOUR), 3 * HOUR);
	const after = Shifted.now();
	assert.ok(Math.abs(after - (RealDate.now() + 3 * HOUR)) < 1000, "Date.now() must carry the offset");
	assert.ok(after - shiftedNow >= 3 * HOUR, "and must not lose time doing it");

	// These two are the whole point. A timestamp the plugin already produced, and
	// a timestamp built from shifted wall-clock components, must both be
	// untouched — shifting either one desynchronises `nextAt - Date.now()`.
	assert.equal(new Shifted(FIXED).getTime(), FIXED);
	assert.equal(new Shifted(FIXED).getHours(), new RealDate(FIXED).getHours());
	assert.equal(
		new Shifted(2026, 4, 17, 9, 30, 0, 0).getTime(),
		new RealDate(2026, 4, 17, 9, 30, 0, 0).getTime(),
		"the local-components constructor must ignore the offset"
	);

	// And the consequence, stated the way the scheduler experiences it: the
	// computed delay must stay inside one period, not grow by the offset.
	const scheduler = realm.plugin.__modules.scheduler;
	const schedule = scheduler.normalizeSchedule({ mode: "interval", intervalMin: 60 });
	const delayBefore = scheduler.nextTriggerAt(schedule, Shifted.now()) - Shifted.now();
	assert.ok(delayBefore > 0 && delayBefore <= HOUR, `unshifted delay was ${delayBefore}ms`);
	const delayAfter = scheduler.nextTriggerAt(schedule, Shifted.now()) - Shifted.now();
	assert.ok(delayAfter > 0 && delayAfter <= HOUR, `a shifted clock produced a ${delayAfter}ms delay — the offset leaked into the arithmetic`);
	assert.equal(preview.shiftClock(0), 0);
});

// ── the panel really is mounted through the shipped path ────────────────────

test("the shipped panel mounts through the shipped slots and React bridge", async () => {
	const { realm, ctx, api } = await bootWithPanel();

	assert.equal(typeof api.panelMounted, "function");
	assert.equal(api.panelMounted(), true, "createReactPanel's effect never ran");

	// Two nested `.lumen-root` nodes: the bridge's own container, and the panel
	// the bridge's effect appended into that container's ref.
	assert.ok(byClass(realm.document, "lumen-root").length >= 2, "the bridge did not append the panel into its ref");
	// The panel's own furniture, which only exists if `createPanel` ran.
	assert.ok(byClass(realm.document, "lumen-slider-input").length >= 4, "the panel's sliders are missing");
	assert.ok(byClass(realm.document, "lumen-chip").length >= 8, "the recipe chips are missing");
	assert.ok(byClass(realm.document, "lumen-seg").length >= 3, "the segmented controls are missing");
	assert.ok(byClass(realm.document, "lumen-row").length >= 8, "the panel's rows are missing");
	assert.ok(byClass(realm.document, "lumen-kv").length >= 2, "the status block is missing");

	// Both declared slots are registered, and the dictionary arrived in both
	// columns — the preview's language toggle depends on that.
	assert.deepEqual(Array.from(ctx.slots.names()).sort(), ["settings.lumen.item", "settings.section"]);
	assert.deepEqual(Array.from(ctx.locale.namespaces()), ["settings.lumen"]);
	const zh = ctx.locale.lookup("settings.lumen", "zh", "group.rotation");
	const en = ctx.locale.lookup("settings.lumen", "en", "group.rotation");
	assert.ok(zh && en && zh !== en, "the dictionary is not actually bilingual");

	// The plugin's contract is that a healthy boot is silent.
	assert.deepEqual(realm.logged, []);

	api.__unmount();
	ctx.dispose();
});

test("the panel renders in English when the shell is English, and only in English", async () => {
	const english = await bootWithPanel({ lang: "en" });
	const chinese = await bootWithPanel({ lang: "zh" });

	const enRotation = english.ctx.locale.lookup("settings.lumen", "en", "group.rotation");
	const zhRotation = chinese.ctx.locale.lookup("settings.lumen", "zh", "group.rotation");
	const enText = english.api.__container.textContent;
	const zhText = chinese.api.__container.textContent;

	assert.ok(zhText.length > 200 && enText.length > 200, "a panel rendered (almost) nothing");
	assert.ok(zhText.includes(zhRotation), "the Chinese panel is missing its own copy");
	assert.ok(enText.includes(enRotation), "the English panel is missing its own copy");
	assert.equal(enText.includes(zhRotation), false, "the English panel leaked the Chinese column");
	assert.equal(zhText.includes(enRotation), false, "the Chinese panel leaked the English column");

	english.api.__unmount();
	chinese.api.__unmount();
	english.ctx.dispose();
	chinese.ctx.dispose();
});

// ── the token surface, which is the plugin's main safety claim ──────────────

test("the plugin overrides exactly one layer, and only the tokens a picture can hurt", async () => {
	const { realm, ctx, api } = await bootWithPanel();
	const theme = ctx.theme;

	assert.deepEqual(Array.from(theme.overrideSources()), ["dsh-lumen:wash"], "the plugin published an unexpected override layer");

	const raw = theme.rawTokens();
	const visible = theme.visibleTokens();
	const changed = Object.keys(visible).filter((name) => raw[name] !== visible[name]).sort();
	// Two surfaces, plus the two quiet labels when the picture makes them
	// unreadable — and nothing else in a 25+ token theme.
	const allowed = ["--dsw-alias-bg-base", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary", "--dsw-specific-sidebar-fill"];
	for (const name of changed) {
		assert.ok(allowed.includes(name), `the plugin changed a token it has no business touching: ${name}`);
	}

	// The two surfaces are handed over transparent, and the tint lives on the
	// plugin's own layer. Composing the alpha into the token is what stacked up
	// across the shell's nested surfaces and swallowed the wallpaper.
	assert.equal(String(visible["--dsw-alias-bg-base"]), "transparent", `the canvas was not handed over: ${visible["--dsw-alias-bg-base"]}`);
	assert.equal(String(visible["--dsw-specific-sidebar-fill"]), "transparent");
	// A quiet label is never made transparent — it is deepened, and stays a colour.
	for (const name of ["--dsw-alias-label-secondary", "--dsw-alias-label-tertiary"]) {
		if (raw[name] === visible[name]) continue;
		assert.notEqual(String(visible[name]), "transparent", `${name} was hidden rather than adjusted`);
		assert.ok(/^rgba?\(/.test(String(visible[name])), `${name} was not published as a colour: ${visible[name]}`);
	}
	assert.ok(washAlpha(realm) < 1, "the plugin painted no veil, so nothing dims the picture");
	assert.ok(Object.keys(visible).length > 25, "the shell published too few tokens for this check to mean anything");

	api.__unmount();
	ctx.dispose();
});

test("the readability floor raises the wash, never lowers it, and can be switched off", async () => {
	const { realm, ctx, api } = await bootWithPanel({ theme: "abyss" });
	const store = api.store;
	const engine = api.engine;
	// The lightest wash the panel's slider can express. Using the real bound
	// rather than a number of my own means this test cannot drift from the UI.
	const lightest = realm.plugin.__modules.state.OPACITY_MIN;

	// A bright picture under a dark theme: light text on the unwashed canvas
	// fails AA, which is exactly the case the floor exists for.
	store.update((draft) => {
		draft.wash.opacity = lightest;
		draft.wash.autoDim = false;
		draft.wash.readability = true;
		draft.single = { kind: "gradient", ref: BRIGHT_GRADIENT, seed: "readability" };
		return draft;
	});
	assert.equal(store.getState().single.kind, "gradient", "the bright backdrop was rejected by state normalisation");
	assert.equal(store.getState().wash.opacity, lightest);
	engine.render(true);

	const required = engine.inspect().requiredAlpha;
	assert.ok(required > lightest, `the floor did not engage over a bright backdrop: required=${required}`);
	const floored = washAlpha(realm);
	assert.ok(Math.abs(floored - required) < 0.005, `the painted alpha ${floored} does not match the reported floor ${required}`);

	// With the floor off, the user's value is the only input — the panel says so,
	// and this is that statement being true.
	store.update((draft) => {
		draft.wash.readability = false;
		return draft;
	});
	engine.render(true);
	assert.equal(engine.inspect().requiredAlpha, 0);
	assert.ok(
		Math.abs(washAlpha(realm) - lightest) < 0.005,
		`with the floor off the user's value should be honoured exactly, got ${washAlpha(realm)}`
	);

	// And a user value above the floor wins: a floor is a floor, not a target.
	store.update((draft) => {
		draft.wash.readability = true;
		draft.wash.opacity = 0.95;
		return draft;
	});
	engine.render(true);
	assert.ok(Math.abs(washAlpha(realm) - 0.95) < 0.005, `the user's 95% was not honoured, got ${washAlpha(realm)}`);

	api.__unmount();
	ctx.dispose();
});

// ── the scheduler demo, driven the way the preview drives it ────────────────

test("a forward clock shift drives the scheduler's catch-up path", async () => {
	const { realm, ctx, api } = await bootWithPanel();
	const store = api.store;
	const engine = api.engine;
	const scheduler = realm.plugin.__modules.scheduler;
	const stateModule = realm.plugin.__modules.state;
	const picks = realm.plugin.__modules.wallpapers.RECIPE_IDS.slice(0, 4);

	store.update((draft) => {
		draft.mode = "rotation";
		draft.playlist = picks.map((id, index) => stateModule.createItem("recipe", id, `rr-${index}`));
		draft.cursor = 0;
		draft.paused = false;
		draft.schedule = { ...draft.schedule, mode: "interval", order: "sequential", intervalMin: 30 };
		return draft;
	});
	engine.reschedule();

	const before = store.getState();
	assert.equal(before.playlist.length, 4);
	assert.equal(before.cursor, 0);
	assert.ok(before.nextAt > realm.Date.now(), "reschedule did not arm a future trigger");

	// A week away: 336 half-hour triggers are suddenly in the past.
	realm.preview.shiftClock(WEEK);
	engine.tick();

	const after = store.getState();
	assert.equal(after.cursor, 1, "the catch-up must advance by exactly one entry, not by every missed one");
	const plan = engine.inspect().plan;
	assert.equal(plan.due, true, "the trigger was not considered due");
	assert.ok(plan.missed > 100, `the skipped triggers were not counted and reported: missed=${plan.missed}`);
	assert.ok(after.nextAt > realm.Date.now(), "the next trigger must be in the future again");
	assert.equal(
		scheduler.upcomingTriggers(scheduler.normalizeSchedule(after.schedule), realm.Date.now(), 3).length,
		3,
		"the schedule stopped producing future triggers"
	);
	// The wallpaper actually changed, rather than only the bookkeeping.
	assert.notEqual(engine.inspect().activeItem.seed, null);

	realm.preview.shiftClock(0);
	api.__unmount();
	ctx.dispose();
});

// ── teardown, and the diagnostics the page reads ────────────────────────────

test("dispose removes the wallpaper, the wash layer and the panel", async () => {
	const { realm, ctx, api } = await bootWithPanel();
	assert.equal(realm.document.documentElement.queryAll((el) => el.getAttribute("data-dsh-lumen") === "root").length, 1);
	assert.equal(ctx.theme.overrideSources().length, 1);

	api.__unmount();
	assert.equal(api.__container.childNodes.length, 0, "the panel was left in the DOM");
	ctx.dispose();

	assert.equal(ctx.theme.overrideSources().length, 0, "the wash outlived the plugin");
	assert.equal(
		realm.document.documentElement.queryAll((el) => el.getAttribute("data-dsh-lumen") === "root").length,
		0,
		"the wallpaper layer outlived the plugin"
	);
	assert.equal(realm.document.documentElement.getAttribute("data-dsh-lumen-active"), null);
	assert.equal(realm.sandbox.__DSH_LUMEN__.status, "disposed");
	assert.deepEqual(realm.logged, []);
});

test("the diagnostics global is the page's whole data source", async () => {
	const { realm, ctx, api } = await bootWithPanel();
	const snapshot = realm.sandbox.__DSH_LUMEN__;
	const state = api.store.getState();
	const inspect = api.engine.inspect();

	assert.ok(snapshot, "the plugin did not publish its diagnostics");
	assert.equal(snapshot.plugin, "dsh-lumen");
	assert.equal(snapshot.status, "ready");
	assert.equal(snapshot.build, realm.plugin.PLUGIN_BUILD);
	assert.equal(typeof snapshot.schema, "number");
	assert.equal(snapshot.mode, state.mode);
	assert.equal(snapshot.playlistLength, state.playlist.length);
	assert.equal(snapshot.nextAt, state.nextAt);
	assert.equal(snapshot.engine.hasDom, true);
	assert.equal(snapshot.health.hasStorage, true);
	assert.equal(snapshot.health.hostAvailable, false, "a realm with no fetch must report the host as unavailable");
	assert.deepEqual(Array.from(snapshot.warnings), []);

	// The page prints these as the "current item" lines.
	assert.equal(snapshot.current.kind, inspect.activeItem.kind);
	assert.equal(snapshot.current.seed, inspect.activeItem.seed);
	assert.ok(typeof snapshot.current.ref === "string");
	assert.ok(snapshot.current.ref.length < 64, "the snapshot echoed a payload instead of describing it");
	// The wash readout compares these two; the panel shows the difference.
	assert.equal(typeof inspect.requiredAlpha, "number");
	assert.equal(typeof inspect.plan.due, "boolean");

	api.__unmount();
	ctx.dispose();
});

// ── the harness can stand in for the host channel ───────────────────────────

test("the harness can serve a host channel, and the durable copy wins", async () => {
	const calls = [];
	const fetchDouble = async (url, init) => {
		calls.push({ url, init });
		const body = JSON.parse(init.body);
		const value = body.method === "get" ? { single: JSON.stringify({ kind: "recipe", ref: "mist", seed: "from-host" }) } : {};
		return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
	};
	const { realm, ctx, api } = await bootWithPanel({ fetch: fetchDouble });

	assert.ok(calls.length > 0, "the store never called the host");
	assert.equal(calls[0].url, "/lumen/api");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(api.store.getHealth().hostAvailable, true);
	assert.equal(api.store.getState().single.seed, "from-host", "the durable copy did not replace the default");
	assert.deepEqual(realm.logged, []);

	api.__unmount();
	ctx.dispose();
});

// ── the preview page's own wiring ───────────────────────────────────────────

test("every file the preview page references exists", () => {
	const html = fs.readFileSync(INDEX_HTML, "utf8");
	const refs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g)).map((match) => match[1]);
	assert.ok(refs.length >= 4, `only ${refs.length} references were parsed out of index.html`);
	for (const ref of refs) {
		if (ref.slice(0, 4) === "http") continue;
		assert.ok(fs.existsSync(path.resolve(path.dirname(INDEX_HTML), ref)), `index.html references ${ref}, which does not exist`);
	}
});

test("every element id the preview controls exists in the page", () => {
	const html = fs.readFileSync(INDEX_HTML, "utf8");
	const source = fs.readFileSync(PREVIEW_JS, "utf8");
	const listBlock = (source.match(/const REQUIRED_IDS = \[([\s\S]*?)\];/) || [])[1];
	assert.ok(listBlock !== undefined, "preview.js does not declare REQUIRED_IDS");
	const ids = Array.from(listBlock.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
	assert.ok(ids.length > 40, `only ${ids.length} ids were parsed; the list is probably stale`);
	const declared = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((match) => match[1]));
	const missing = ids.filter((id) => !declared.has(id));
	assert.deepEqual(missing, [], `preview/index.html is missing: ${missing.join(", ")}`);
});

test("the preview's tabs match the sections it toggles", () => {
	const html = fs.readFileSync(INDEX_HTML, "utf8");
	const source = fs.readFileSync(PREVIEW_JS, "utf8");
	const tabs = Array.from(html.matchAll(/data-tab="([^"]+)"/g)).map((match) => match[1]);
	assert.ok(tabs.length >= 3, "the preview has fewer tabs than sections");
	for (const tab of tabs) {
		assert.ok(html.includes(`id="pg-tab-${tab}"`), `the "${tab}" tab has no section`);
		// `setTab` hides every section it does not know about, so a tab missing
		// from that list would render on top of the others.
		assert.ok(source.includes(`"${tab}"`), `preview.js does not know about the "${tab}" tab`);
	}
});

// ── the preview server ──────────────────────────────────────────────────────

/**
 * The server no longer mirrors anything: it mounts `lib/index.js`. So this test
 * is not checking that two implementations agree — it is checking that the one
 * implementation is reachable, through the seam the preview puts in front of it.
 */
test("the preview server serves the real host half's routes and merge rules", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-preview-"));
	const stateFile = path.join(dir, "lumen.json");
	const child = spawn(process.execPath, [SERVE, "--port", "0", "--state", stateFile], { stdio: ["ignore", "pipe", "pipe"] });
	let killed = false;
	t.after(() => {
		if (!killed) {
			killed = true;
			child.kill();
		}
	});

	let banner = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		banner += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no banner within 8s.\nstdout: ${banner}\nstderr: ${stderr}`)), 8000);
		child.stdout.on("data", () => {
			if (/url\s+http:\/\/127\.0\.0\.1:\d+\//.test(banner)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("error", reject);
	});

	const port = Number((banner.match(/url\s+http:\/\/127\.0\.0\.1:(\d+)\//) || [])[1]);
	assert.ok(Number.isInteger(port) && port > 0, `could not read the port out of: ${banner}`);
	const origin = `http://127.0.0.1:${port}`;
	const api = `${origin}/lumen/api`;
	async function post(body) {
		const response = await fetch(api, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});
		return { status: response.status, payload: await response.json() };
	}

	assert.deepEqual((await post({ method: "get" })).payload, { ok: true, value: {} });

	// The mounted host half resolves its own paths from `$DSH_HOME`, which the
	// server pinned before importing it. `ping` reports the path it resolved, so
	// this is the end-to-end proof that the real module is in play and that the
	// user's profile is unreachable from here — a copy with the same behaviour
	// would still answer this, but a copy pointed anywhere else would not.
	assert.equal(
		(await post({ method: "ping" })).payload.value.file,
		stateFile,
		"the mounted host half is not writing where the server said it would"
	);

	// A merge, not a replacement: the second write must not drop the first key.
	assert.equal((await post({ method: "set", patch: { wash: '{"opacity":0.5}', single: '{"kind":"recipe"}' } })).status, 200);
	assert.equal((await post({ method: "set", patch: { play: "1" } })).status, 200);
	assert.deepEqual(
		Object.keys((await post({ method: "get" })).payload.value).sort(),
		["play", "single", "wash"],
		"a patch replaced the document instead of merging into it"
	);

	// `null` deletes; a key absent from the patch leaves its neighbours alone.
	assert.equal((await post({ method: "set", patch: { single: null } })).status, 200);
	assert.deepEqual(Object.keys((await post({ method: "get" })).payload.value).sort(), ["play", "wash"]);

	// Non-string values are refused rather than smuggled into the file, and the
	// reserved stamp can never be adopted as a preference.
	assert.equal((await post({ method: "set", patch: { bad: 42, "dsh-lumen:schema-version": "9" } })).status, 200);
	assert.deepEqual(Object.keys((await post({ method: "get" })).payload.value).sort(), ["play", "wash"]);
	assert.ok(fs.readFileSync(stateFile, "utf8").includes("dsh-lumen:schema-version"), "the file was not stamped");
	assert.equal((await post({ method: "ping" })).payload.value.keys, 2);

	// The route refuses what the host refuses.
	assert.equal((await fetch(api, { method: "GET" })).status, 405);
	assert.equal((await fetch(api, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
	assert.equal((await post({ method: "nope" })).status, 404);
	assert.equal((await post(null)).status, 400);

	// Static files, and a traversal attempt that must not escape the root.
	assert.equal((await fetch(`${origin}/`)).status, 200, "the root must serve the preview page");
	assert.equal((await fetch(`${origin}/preview/index.html`)).status, 200);
	assert.equal((await fetch(`${origin}/lib/client.js`)).status, 200);
	assert.equal((await fetch(`${origin}/%2e%2e%2f%2e%2e%2fpackage.json`)).status, 403, "path traversal must be refused");
	assert.equal((await fetch(`${origin}/nope.js`)).status, 404);

	// ── the splash, end to end through the mounted host half ────────────────
	//
	// Written straight into the state file and the media directory rather than
	// uploaded, because this test is about whether the *preview* carries the
	// splash through — the upload path itself is covered in tests/host.test.cjs,
	// against the same module, with a response object it can inspect.
	const media = "media-preview-0123abcd.png";
	const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
	fs.mkdirSync(path.join(dir, "lumen-media"), { recursive: true });
	fs.writeFileSync(path.join(dir, "lumen-media", media), bytes);
	fs.writeFileSync(stateFile, JSON.stringify({ "splash.media": media, "dsh-lumen:schema-version": "1" }));

	// The shell's index gets the cover; the preview's own page does not.
	const shell = await fetch(`${origin}/preview/boot.html`);
	assert.equal(shell.status, 200);
	const shellHtml = await shell.text();
	assert.ok(shellHtml.includes("dsh-lumen-splash-cover"), "the shell stand-in was served without the injected cover");
	assert.ok(shellHtml.includes("__DSH_LUMEN_SPLASH__"), "the bounded way out was not injected");
	assert.ok(shellHtml.indexOf("dsh-lumen-splash-cover") < shellHtml.indexOf("</head>"), "the cover rows landed outside the head");

	const chrome = await fetch(`${origin}/preview/index.html`);
	const chromeHtml = await chrome.text();
	assert.equal(chromeHtml.includes("dsh-lumen-splash-cover"), false, "the main preview page was covered by a splash");

	// The media route is the host half's own, ranges and all.
	const full = await fetch(`${origin}/lumen/splash/media`);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get("content-type"), "image/png");
	assert.equal(full.headers.get("accept-ranges"), "bytes");
	assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

	const ranged = await fetch(`${origin}/lumen/splash/media`, { headers: { range: "bytes=10-19" } });
	assert.equal(ranged.status, 206);
	assert.equal(ranged.headers.get("content-range"), `bytes 10-19/${bytes.length}`);
	assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(10, 20));

	assert.equal((await fetch(`${origin}/lumen/splash/media`, { headers: { range: "bytes=9999-" } })).status, 416);
	assert.equal((await fetch(`${origin}/lumen/splash/media`, { method: "PUT" })).status, 405);

	killed = true;
	child.kill();
});

// ── the injected rows, and the seam that carries them ───────────────────────

test("an injected row the preview cannot serve is refused, not skipped", () => {
	const serve = require(SERVE);
	const shell = `<html ${serve.SHELL_DOCUMENT_MARKER}><head></head><body></body></html>`;

	assert.equal(serve.applyInjections(shell, []), shell, "no rows must mean an untouched document");
	assert.equal(
		serve.applyInjections("<html><head></head><body></body></html>", [{ kind: "style", text: "/* x */" }]),
		"<html><head></head><body></body></html>",
		"a document that has not declared itself the shell's index must be left alone"
	);

	const injected = serve.applyInjections(shell, [
		{ kind: "style", text: "/* a */" },
		{ kind: "script", placement: "head", text: "// b" }
	]);
	assert.ok(injected.includes("<style>/* a */</style>"), "the style row was not spliced in");
	assert.ok(injected.includes("<script>// b</script>"), "the script row was not spliced in");
	assert.ok(injected.indexOf("// b") < injected.indexOf("</head>"), "the rows landed outside the head");
	assert.ok(injected.indexOf("/* a */") < injected.indexOf("// b"), "the rows were reordered");
	// Nothing outside the head may move: the marker attribute is still on the
	// document element and the body is still the body.
	assert.ok(injected.startsWith(`<html ${serve.SHELL_DOCUMENT_MARKER}><head>`), "the head's opening was disturbed");
	assert.ok(injected.endsWith("</head><body></body></html>"), "the document after the head was disturbed");

	// An unknown row kind must be loud. A preview that skipped what it did not
	// understand would serve a document that looks like the shell's and is not —
	// which is the entire failure class this server was rewritten to remove.
	assert.throws(() => serve.applyInjections(shell, [{ kind: "global", name: "x", value: 1 }]), /does not know how to serve/);
	assert.throws(() => serve.applyInjections(shell, [{ kind: "script", placement: "body", text: "" }]), /cannot inject a script at/);
	assert.throws(() => serve.applyInjections(shell, [null]), /must be an object/);
});

test("the preview mounts the real host half, routes and all", async (t) => {
	const serve = require(SERVE);
	const previous = process.env.DSH_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-mount-"));
	// The module reads DSH_HOME per call rather than at load, so pinning it here
	// is enough — and it has to be pinned, or this test would read whatever the
	// developer's real profile happens to hold.
	process.env.DSH_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	});

	const bridge = serve.createHostContext();
	const hostModule = await import(pathToFileURL(HOST_MODULE).href);
	hostModule.apply(bridge.ctx);

	assert.deepEqual(bridge.routes.map((route) => route.path).sort(), ["/lumen/api", "/lumen/splash", "/lumen/wallpaper"]);
	assert.equal(bridge.effectLabels().length, 3, "a route was registered outside an effect and would outlive dispose");
	// A fresh install has no document at all, and the answer is the packaged
	// clip rather than nothing: the splash ships on, and `splash.source` is what
	// a user sets to `off` to get out of it.
	const initial = bridge.collectRows();
	assert.equal(initial.length, 2, "a fresh install must be covered by the built-in splash");
	assert.equal(initial[0].kind, "style");
	assert.ok(!initial[0].text.includes("background-image"), "the built-in splash is a clip, and CSS cannot paint one");

	const media = "media-mount-deadbeef.png";
	fs.mkdirSync(path.join(home, "lumen-media"), { recursive: true });
	fs.writeFileSync(path.join(home, "lumen-media", media), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	fs.writeFileSync(path.join(home, "lumen.json"), JSON.stringify({ "splash.media": media, "dsh-lumen:schema-version": "1" }));

	const rows = bridge.collectRows();
	assert.equal(rows.length, 2, "a configured splash must contribute exactly two rows");
	assert.equal(rows[0].kind, "style");
	assert.ok(rows[0].text.includes("/lumen/splash/media"), "the cover does not point at the media route");
	assert.equal(rows[1].kind, "script");
	assert.equal(rows[1].placement, "head");

	// A name that fails the shape check is not a splash. Written by hand rather
	// than through an upload, which is exactly the case the read-side revalidation
	// exists for.
	// `splash.source: custom` is what makes this the user's own clip rather than
	// a fresh install, so the name is the only thing that can decide the answer.
	fs.writeFileSync(path.join(home, "lumen.json"), JSON.stringify({ "splash.media": "../../etc/passwd", "splash.source": "custom", "dsh-lumen:schema-version": "1" }));
	assert.deepEqual(bridge.collectRows(), [], "the host half served a name that never came from its own generator");

	bridge.dispose();
	assert.equal(bridge.routes.length, 0, "dispose left a route registered");
});

test("the preview routes a request to the prefix that owns it", () => {
	const serve = require(SERVE);
	const routes = [
		{ kind: "prefix", path: "/lumen/api", handler: () => {} },
		{ kind: "prefix", path: "/lumen/splash", handler: () => {} }
	];
	assert.equal(serve.matchingRoute("/lumen/api", routes).path, "/lumen/api");
	assert.equal(serve.matchingRoute("/lumen/splash/media", routes).path, "/lumen/splash");
	assert.equal(serve.matchingRoute("/lumen/splash", routes).path, "/lumen/splash");
	// A path that merely starts with the same characters is not in the prefix.
	assert.equal(serve.matchingRoute("/lumen/apis", routes), null);
	assert.equal(serve.matchingRoute("/preview/index.html", routes), null);
});

test("the preview server pins the host half's home into the repo", () => {
	const source = fs.readFileSync(SERVE, "utf8");
	assert.ok(source.indexOf("homedir") < 0, "the preview server resolved a home directory itself; a demo must not touch the real profile");
	assert.ok(source.includes('path.join(ROOT, "preview", ".state", "lumen.json")'), "the state file does not default inside the repo");
	// The pin is the mechanism: without it the *mounted* module would resolve the
	// developer's real `~/.dsh`, and no amount of care in this file would help.
	assert.ok(source.includes("process.env.DSH_HOME = stateDir"), "the preview server never pinned DSH_HOME");
	assert.ok(source.includes('await import(pathToFileURL(HOST_MODULE).href)'), "the preview server does not mount the host half");
});

test("the shell stand-in references only files that exist", () => {
	const html = fs.readFileSync(BOOT_HTML, "utf8");
	const refs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g)).map((match) => match[1]);
	assert.ok(refs.length >= 4, `only ${refs.length} references were parsed out of boot.html`);
	assert.ok(refs.includes("./boot.js"), "boot.html does not load the file that hands the shell over");
	for (const ref of refs) {
		if (ref.slice(0, 4) === "http") continue;
		assert.ok(fs.existsSync(path.resolve(path.dirname(BOOT_HTML), ref)), `boot.html references ${ref}, which does not exist`);
	}
	assert.ok(html.includes("data-dsh-lumen-shell-document"), "boot.html does not declare itself the shell's index, so nothing would be injected");
	assert.ok(html.includes("data-dsh-boot"), "boot.html has no boot kernel, so the handoff the cover waits for never happens");
	assert.ok(fs.existsSync(BOOT_JS), "boot.js does not exist");
});

test("the main preview page is not the shell's document, and says so by omission", () => {
	const html = fs.readFileSync(INDEX_HTML, "utf8");
	assert.equal(
		html.includes("data-dsh-lumen-shell-document"),
		false,
		"index.html declared itself the shell's index; a splash would then cover the preview chrome"
	);
	// The other half of the pairing: a reader has to be able to get from the
	// preview to the page that can show the splash.
	assert.ok(html.includes('href="./boot.html"'), "the preview does not link to the shell stand-in");
});
