"use strict";
/**
 * The browser half's entry point.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT REFUSES TO DO
 *
 * It wires five things together and nothing else: persistence (`store`), the
 * page (`engine`), the splash (`splash`), the settings UI (`panel` via the React
 * bridge), and the host's services (`theme`, `slots`, `locale`). Every one of
 * those is a module with its own tests; this file is the seam, so it is written
 * to be as boring as possible in exactly one way:
 *
 *   **IT NEVER THROWS.** A cordis loader-entry factory that throws aggregates
 *   into a host-level "entries did not activate" and takes the entire web shell
 *   down with it — the user loses their whole app because a wallpaper plugin
 *   had a bad day. So every platform service is probed with `typeof` before use,
 *   every registration is wrapped, and the failure mode is always "the wallpaper
 *   does not appear and one line is logged", never "DSH fails to boot".
 *
 * `inject` is exported for the loader to order this plugin after its services.
 * A missing service in that list is a degrade, not a crash: the plugin checks
 * for it at use site anyway.
 */

const { createStore } = require("./store.cjs");
const { createEngine } = require("./engine.cjs");
const { createSplash } = require("./splash.cjs");
const { createPanel } = require("./ui/panel.cjs");
const { createReactPanel, createReactSection } = require("./react-bridge.cjs");
const { NS, createTranslator, dictionaries } = require("./i18n.cjs");
const { SCHEMA } = require("./state.cjs");

/** Where the fenced host persistence route lives. */
const API_PATH = "/lumen/api";
/** The settings section id and its child slot. */
const SECTION_ID = "lumen";
const ITEM_SLOT = "settings.lumen.item";
/** Global carrying the read-only diagnostics snapshot. */
const STATUS_GLOBAL = "__DSH_LUMEN__";
/** Build string published in diagnostics; mirrors `package.json`. */
const PLUGIN_BUILD = "1.3.2";

/** Services this plugin wants before `apply` runs. */
const inject = ["slots", "locale", "theme"];

/**
 * Narrow the runtime's language to the two dictionaries we ship.
 * Chinese is the default because the package's primary audience and its
 * documentation are Chinese; English is a complete mirror, not a partial one.
 */
function resolveLanguage(ctx) {
	try {
		const candidates = [];
		if (ctx && ctx.locale && typeof ctx.locale.getLanguage === "function") candidates.push(ctx.locale.getLanguage());
		if (typeof navigator !== "undefined" && navigator.language) candidates.push(navigator.language);
		for (const candidate of candidates) {
			if (typeof candidate !== "string") continue;
			return candidate.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
		}
	} catch {}
	return "zh";
}

/** Publish the read-only diagnostics snapshot host/desktop tooling can read. */
function publishStatus(store, engine, splash, extra) {
	try {
		if (typeof window === "undefined") return;
		const health = store === null ? null : store.getHealth();
		const state = store === null ? null : store.getState();
		const inspect = engine === null ? null : engine.inspect();
		window[STATUS_GLOBAL] = {
			plugin: "dsh-lumen",
			build: PLUGIN_BUILD,
			schema: SCHEMA,
			// Which half is doing what about the splash: `guard-only` means the
			// injected stylesheet and its guard own it, `clip` means this half has a
			// layer up. A person debugging "the splash will not go away" needs to
			// know which of the two is holding it.
			splash: splash === null ? null : splash.inspect(),
			...(extra || {}),
			health,
			engine: inspect,
			mode: state === null ? null : state.mode,
			current: state === null || inspect === null || inspect.activeItem === null
				? null
				: { kind: inspect.activeItem.kind, ref: inspect.activeItem.kind === "image" ? "(blob)" : inspect.activeItem.ref, seed: inspect.activeItem.seed },
			playlistLength: state === null ? 0 : state.playlist.length,
			nextAt: state === null ? 0 : state.nextAt,
			publishedAt: Date.now()
		};
	} catch {}
}

/**
 * Client plugin body.
 * @param {object} ctx cordis client context
 */
function apply(ctx) {
	const warnings = [];
	const warn = (message, error) => {
		const text = `[dsh-lumen] ${message}${error && error.message ? `: ${error.message}` : ""}`;
		warnings.push(text);
		try {
			console.warn(text);
		} catch {}
	};

	// ── React, proxied through the host's module table ────────────────────────
	// A missing React means the settings panel cannot be mounted, but the
	// wallpaper itself needs no framework at all — so the plugin keeps working
	// and only the UI is skipped.
	let React = null;
	try {
		React = require("react");
	} catch (error) {
		warn("react unavailable — the settings panel will not mount", error);
	}

	const language = resolveLanguage(ctx);
	const t = createTranslator(language);

	// ── locale ────────────────────────────────────────────────────────────────
	try {
		if (ctx && ctx.locale && typeof ctx.locale.register === "function") {
			ctx.effect(() => ctx.locale.register(NS, dictionaries()), "dsh-lumen: locale dictionaries");
		}
	} catch (error) {
		warn("locale registration failed", error);
	}

	// ── persistence + engine ──────────────────────────────────────────────────
	const store = createStore({ apiPath: API_PATH });
	const engine = createEngine({ ctx, store });

	// ── splash ────────────────────────────────────────────────────────────────
	// Started before the store loads, and deliberately so: the only thing this
	// half does at boot is get a clip in front of the interface, and every
	// millisecond it spends waiting for a document it does not need is a
	// millisecond of black the user is looking at instead of a clip. An image
	// splash needs nothing here at all — the host's own injected stylesheet and
	// guard handle it, cover to release.
	const splash = createSplash({ t });
	try {
		splash.startCover();
	} catch (error) {
		warn("splash boot failed — the cover will still release on its own deadline", error);
	}

	// ── settings UI ───────────────────────────────────────────────────────────
	let panelMounted = false;
	if (React !== null) {
		try {
			const slots = ctx && ctx.slots;
			if (slots && typeof slots.inject === "function" && typeof slots.register === "function") {
				const Section = createReactSection(React, ITEM_SLOT);
				const Row = createReactPanel(React, () => {
					panelMounted = true;
					return createPanel({ store, engine, splash, t, lang: language });
				});
				slots.inject("settings.section", () =>
					slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: 30,
						// One name, in the user's language. "壁纸 / Wallpaper" was both
						// languages at once in a column where every neighbour is a
						// single word.
						label: t("section.label"),
						locale: NS,
						children: { [ITEM_SLOT]: { kind: "list", scope: "root" } }
					}, Section)
				);
				slots.inject(ITEM_SLOT, () =>
					slots.register({
						name: ITEM_SLOT,
						id: SECTION_ID,
						order: 10,
						locale: NS
					}, Row)
				);
			} else {
				warn("slots service unavailable — settings panel not registered");
			}
		} catch (error) {
			warn("settings section registration failed", error);
		}
	}

	// ── boot ──────────────────────────────────────────────────────────────────
	// The seed paints synchronously-ish first (`load` reads storage before it
	// awaits anything), then the durable host copy replaces it, then the engine
	// starts with the authoritative values.
	publishStatus(store, engine, splash, { status: "booting", warnings: warnings.slice() });
	store
		.load()
		.then((state) => {
			engine.start();
			publishStatus(store, engine, splash, { status: "ready", warnings: warnings.slice() });
			return state;
		})
		.catch((error) => {
			warn("boot failed — falling back to defaults", error);
			try {
				engine.start();
			} catch {}
			publishStatus(store, engine, splash, { status: "degraded", warnings: warnings.slice() });
		});

	// ── teardown ──────────────────────────────────────────────────────────────
	try {
		ctx.effect(
			() => () => {
				try {
					engine.dispose();
				} catch {}
				try {
					// The clip layer first: it is the only thing in this plugin that
					// can be left covering the interface after the plugin is gone.
					splash.dispose();
				} catch {}
				try {
					store.dispose();
				} catch {}
				try {
					if (typeof window !== "undefined") window[STATUS_GLOBAL] = { plugin: "dsh-lumen", build: PLUGIN_BUILD, status: "disposed" };
				} catch {}
			},
			"dsh-lumen: teardown"
		);
	} catch (error) {
		warn("teardown effect registration failed", error);
	}

	return { store, engine, splash, panelMounted: () => panelMounted };
}

module.exports = { apply, inject, API_PATH, STATUS_GLOBAL, ITEM_SLOT, SECTION_ID, NS, PLUGIN_BUILD };
