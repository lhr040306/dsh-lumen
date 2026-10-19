"use strict";
/**
 * The shipped bundle, loaded the way the shell loads it.
 *
 * This is the only test that exercises the contract rather than the modules: it
 * evaluates `lib/client.js` behind a `window.__ModuleLoader__` double, then
 * calls `apply` against a fake cordis context and asserts that a wallpaper
 * actually lands in the document.
 *
 * It exists because the failure it catches is otherwise invisible. A wrong
 * relative require inside the entry point — `./panel.cjs` when the file is at
 * `./ui/panel.cjs` — is a `MODULE_NOT_FOUND` at *load* time, before `apply` is
 * ever called, so every unit test still passes and the plugin simply does
 * nothing in the shell. Nothing short of loading the bundle finds it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createDocument, createWindow, createStorage } = require("./helpers/minidom.cjs");

const BUNDLE = path.join(__dirname, "..", "lib", "client.js");

/**
 * Load the bundle behind a loader double.
 *
 * The double has to do what the shell's loader does, not just record the call:
 * `load({id, factory})` is answered by invoking the factory with a `require`
 * that resolves platform seeds. Skipping that step would make the whole test
 * vacuous — the bundle's exports live in the factory's return value.
 *
 * @param {object} [options]
 * @param {boolean} [options.withReact] whether the host has a `react` seed
 * @returns {{exports: object, loadCalls: object[], logged: string[], document: object, window: object, hostRequires: string[]}}
 */
function loadBundle(options) {
	const opts = options || {};
	const withReact = opts.withReact !== false;
	const loadCalls = [];
	const logged = [];
	const hostRequires = [];
	const document = opts.document || createDocument();
	const window = createWindow(document);
	const React = createReact();
	window.localStorage = createStorage();
	window.__ModuleLoader__ = {
		load: (entry) => {
			const hostRequire = (id) => {
				hostRequires.push(id);
				if (id === "react" && withReact) return React;
				// Anything else is a platform seed this plugin does not use; the
				// shell would throw, and the plugin must survive that.
				throw new Error(`Cannot find module '${id}'`);
			};
			// The shell's loader answers `load` by invoking the factory and handing
			// the result to the plugin runtime; that result *is* the exports.
			loadCalls.push({ id: entry.id, exports: entry.factory(hostRequire) });
			return entry;
		}
	};
	window.console = {
		warn: (...args) => logged.push(args.join(" ")),
		error: (...args) => logged.push(args.join(" ")),
		log: () => {}
	};

	const sandbox = {
		window,
		document,
		React,
		console: window.console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		navigator: { language: "zh-CN" },
		fetch: undefined,
		URL
	};
	sandbox.globalThis = sandbox;
	const source = fs.readFileSync(BUNDLE, "utf8");
	// `vm.runInNewContext` gives the bundle the same shape it gets in the shell:
	// no module wrapper, `window` in scope, and `require` only via the factory.
	vm.runInNewContext(source, sandbox, { filename: BUNDLE });
	assert.equal(loadCalls.length, 1, "the bundle did not register exactly one module");
	return { exports: loadCalls[0].exports, loadCalls, logged, document, window, hostRequires };
}

/**
 * Let the boot promise settle.
 *
 * `apply` deliberately does not paint synchronously: it starts the engine after
 * `store.load()` resolves, so the first paint already has the durable settings.
 * Asserting before that tick would be asserting a race.
 */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The minimum React surface the bridge uses. */
function createReact() {
	const refs = [];
	return {
		refs,
		useRef: () => {
			const ref = { current: null };
			refs.push(ref);
			return ref;
		},
		useEffect: () => {},
		createElement: (type, props, ...children) => ({ type, props, children })
	};
}

/** A cordis client context double, recording what the plugin registers. */
function createCtx(applied) {
	const registered = { slots: [], locale: [], overrides: [], effects: [], events: [], disposers: [] };
	const ctx = {
		registered,
		locale: {
			getLanguage: () => "zh-CN",
			register: (ns, dict) => {
				if (applied === true) registered.locale.push({ ns, dict });
				return () => {};
			}
		},
		slots: {
			inject: (name, fn) => {
				if (applied === true) registered.slots.push({ name });
				if (typeof fn === "function") fn();
			},
			register: (options) => {
				if (applied === true) registered.slots.push(options);
				return () => {};
			}
		},
		theme: {
			getTheme: () => ({
				preference: "dark-default",
				themes: [
					{
						id: "dark-default",
						colorScheme: "dark",
						tokens: {
							"--dsw-alias-bg-base": "#101418",
							"--dsw-alias-label-primary": "#f2f5f8",
							"--dsw-specific-sidebar-fill": "#0c0f13"
						}
					}
				],
				active: { id: "dark-default", tokens: {} }
			}),
			overrideTokens: (source, tokens) => {
				if (applied === true) registered.overrides.push({ source, tokens });
				return () => {};
			}
		},
		// cordis *runs* an effect and keeps its disposer; recording without
		// invoking would leave every registration inside an effect untested.
		effect: (fn, label) => {
			if (applied === true) registered.effects.push({ label });
			const disposer = typeof fn === "function" ? fn() : null;
			if (typeof disposer === "function") registered.disposers.push(disposer);
			return disposer;
		},
		on: (name) => {
			if (applied === true) registered.events.push(name);
		}
	};
	return ctx;
}

test("the shipped bundle exists and is not stale", () => {
	assert.ok(fs.existsSync(BUNDLE), "lib/client.js is missing — run npm run build");
	const source = fs.readFileSync(BUNDLE, "utf8");
	assert.ok(source.indexOf("__ModuleLoader__.load") > 0, "the bundle does not use the loader contract");
	assert.ok(source.indexOf('"dsh-lumen"') > 0, "the bundle is not registered under the plugin id");
});

test("the bundle registers the loader entry and exposes the entry point", () => {
	const { exports } = loadBundle();
	assert.equal(typeof exports.apply, "function", "apply is not exported");
	assert.deepEqual(Array.from(exports.inject), ["slots", "locale", "theme"]);
	assert.equal(exports.API_PATH, "/lumen/api");
	assert.equal(exports.SECTION_ID, "lumen");
	assert.equal(exports.ITEM_SLOT, "settings.lumen.item");
	assert.equal(exports.STATUS_GLOBAL, "__DSH_LUMEN__");
	// The preview needs these without booting the plugin.
	for (const name of ["wallpapers", "scheduler", "state", "engine", "store", "panel"]) {
		assert.ok(exports.__modules[name], `__modules.${name} is missing`);
	}
});

test("every module in the bundle actually loads", () => {
	// A broken relative require inside any module surfaces here, as a thrown
	// load rather than as a plugin that silently does nothing.
	const { exports } = loadBundle();
	assert.equal(typeof exports.__modules.panel.createPanel, "function");
	assert.equal(typeof exports.__modules.engine.createEngine, "function");
	assert.equal(typeof exports.__modules.store.createStore, "function");
	assert.equal(typeof exports.__modules.state.normalizeState, "function");
	assert.equal(typeof exports.__modules.scheduler.nextTriggerAt, "function");
	assert.equal(typeof exports.__modules.wallpapers.renderRecipe, "function");
});

test("apply mounts a wallpaper into the document", async () => {
	const { exports, document, window } = loadBundle();
	const ctx = createCtx(true);
	const handle = exports.apply(ctx);
	assert.ok(handle && handle.store, "apply did not return its services");
	// Paint happens after `store.load()` settles, so the first frame already has
	// the durable settings rather than the defaults.
	await settle();

	const layers = document.documentElement.queryAll((el) => el.getAttribute("data-dsh-lumen") === "root");
	assert.equal(layers.length, 1, "no wallpaper layer was created");
	assert.equal(document.body.firstChild, layers[0], "the layer was not prepended behind the app");
	assert.equal(layers[0].childNodes.length, 5, "the layer stack is incomplete");
	assert.ok(ctx.registered.overrides.length > 0, "the wash was never published to the theme");
	assert.equal(ctx.registered.locale.length, 1, "the locale dictionary was not registered");
	assert.equal(ctx.registered.locale[0].ns, "settings.lumen");
	assert.deepEqual(Object.keys(ctx.registered.locale[0].dict).sort(), ["en", "zh"]);
	assert.ok(ctx.registered.slots.some((s) => s.id === "lumen"), "the settings section was not registered");
	assert.ok(window.__DSH_LUMEN__, "the diagnostics global was not published");
	assert.equal(window.__DSH_LUMEN__.plugin, "dsh-lumen");
	assert.equal(window.__DSH_LUMEN__.status, "ready");
	handle.engine.dispose();
	handle.store.dispose();
});

test("a missing React degrades to a wallpaper with no settings panel", async () => {
	// The bundle resolves `react` through the host's module table. With no such
	// entry the require throws, and the plugin must carry on: the wallpaper
	// needs no framework, only the settings UI does.
	const { exports, document, logged } = loadBundle({ withReact: false });
	const ctx = createCtx(true);
	const handle = exports.apply(ctx);
	await settle();
	assert.equal(ctx.registered.slots.some((s) => s.id === "lumen"), false, "the panel registered without React");
	assert.equal(document.documentElement.queryAll((el) => el.getAttribute("data-dsh-lumen") === "root").length, 1, "the wallpaper must not depend on React");
	// And it says so, rather than failing invisibly.
	assert.ok(logged.some((line) => line.indexOf("react") >= 0), `no warning was logged: ${logged.join(" | ")}`);
	handle.engine.dispose();
	handle.store.dispose();
});

test("apply never throws, even with no services at all", () => {
	// The whole plugin's contract: a wallpaper plugin must never be the reason
	// DSH fails to boot.
	const { exports } = loadBundle();
	for (const ctx of [{}, { locale: null, slots: null, theme: null }, { effect: null }, null]) {
		assert.doesNotThrow(() => {
			const handle = exports.apply(ctx || {});
			if (handle && handle.engine) handle.engine.dispose();
			if (handle && handle.store) handle.store.dispose();
		}, `apply threw for ${JSON.stringify(ctx)}`);
	}
});

test("apply survives each service throwing", async () => {
	const { exports } = loadBundle();
	const hostile = () => ({
		locale: { getLanguage: () => { throw new Error("nope"); }, register: () => { throw new Error("nope"); } },
		slots: { inject: () => { throw new Error("nope"); }, register: () => { throw new Error("nope"); } },
		theme: { getTheme: () => { throw new Error("nope"); }, overrideTokens: () => { throw new Error("nope"); } },
		effect: () => { throw new Error("nope"); },
		on: () => { throw new Error("nope"); }
	});
	let handle = null;
	assert.doesNotThrow(() => {
		handle = exports.apply(hostile());
	});
	await settle();
	assert.ok(handle && handle.store, "apply did not survive three hostile services");
	handle.engine.dispose();
	handle.store.dispose();
});
