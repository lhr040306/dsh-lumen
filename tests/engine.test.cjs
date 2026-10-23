"use strict";
/**
 * The render engine.
 *
 * These are the assertions that a screenshot would not give you. The engine's
 * job is not "is there a picture" but the invariants around it: that the wash
 * never compounds across repaints, that a hue drag does not strobe, that
 * teardown leaves no trace, and that a DOM-less environment degrades instead of
 * throwing. Each of those is invisible on screen right up until it is a bug
 * report, so they are pinned here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEngine, itemToBackground, readRawTheme, readPaletteFromDom, mascotHitTest, ACTIVE_ATTR, MASCOT_STATE_ATTR, COMPOSER_STATE_ATTR, MASCOT_W, MASCOT_H, STYLE_ID, CONTRAST_TARGET, CANVAS_VAR, PANEL_VAR, SEAM_VAR } = require("../src/engine.cjs");
const { createStore } = require("../src/store.cjs");
const { createDocument, createWindow, createStorage } = require("./helpers/minidom.cjs");
const color = require("../src/color.cjs");

const DARK_TOKENS = {
	"--dsw-alias-bg-base": "#101418",
	"--dsw-alias-label-primary": "#f2f5f8",
	"--dsw-specific-sidebar-fill": "#0c0f13"
};
const LIGHT_TOKENS = {
	"--dsw-alias-bg-base": "#ffffff",
	"--dsw-alias-label-primary": "#111111",
	"--dsw-specific-sidebar-fill": "#f4f5f7"
};

/**
 * A stand-in for the host's theme service.
 *
 * The important part is `getTheme().active.tokens`: it reports the currently
 * *composed* tokens — raw definitions plus whatever this plugin has already
 * overridden. That is what the real service does, and it is what makes the
 * compounding-wash bug reproducible: a naive engine reads its own wash back and
 * darkens the canvas a little more on every repaint.
 */
function createCtx() {
	const defs = [
		{ id: "dark-default", colorScheme: "dark", tokens: { ...DARK_TOKENS } },
		{ id: "light-default", colorScheme: "light", tokens: { ...LIGHT_TOKENS } }
	];
	const state = { preference: "dark-default", overrides: new Map(), pushes: [], listeners: [] };
	const composedTokens = () => {
		const def = defs.find((d) => d.id === state.preference) || defs[0];
		const tokens = { ...def.tokens };
		for (const layer of state.overrides.values()) {
			for (const [token, pair] of Object.entries(layer)) tokens[token] = pair[def.colorScheme] ?? pair.dark;
		}
		return tokens;
	};
	const theme = {
		defs,
		get preference() {
			return state.preference;
		},
		get overrides() {
			return state.overrides;
		},
		get pushes() {
			return state.pushes;
		},
		getTheme: () => {
			const def = defs.find((d) => d.id === state.preference) || defs[0];
			return {
				preference: state.preference,
				themes: defs.map((d) => ({ id: d.id, colorScheme: d.colorScheme, tokens: { ...d.tokens } })),
				active: { id: def.id, colorScheme: def.colorScheme, tokens: composedTokens() }
			};
		},
		overrideTokens: (source, tokens) => {
			state.overrides.set(source, tokens);
			state.pushes.push({ source, tokens });
			return () => state.overrides.delete(source);
		},
		setPreference: (id) => {
			state.preference = id;
		}
	};
	return {
		theme,
		on: () => {},
		emitThemeChange: () => {
			for (const listener of state.listeners) listener();
		},
		listen: (fn) => state.listeners.push(fn)
	};
}

/** A store + engine wired to the in-memory DOM. */
function makeEngine(options) {
	const opts = options || {};
	const document = opts.document === undefined ? createDocument() : opts.document;
	const win = opts.window === undefined ? createWindow(document) : opts.window;
	const ctx = opts.ctx || createCtx();
	const store = createStore({ apiPath: "/lumen/api", storage: createStorage(), fetchImpl: null });
	const engine = createEngine({ ctx, store, document, window: win });
	return { document, win, ctx, store, engine, theme: ctx.theme };
}

/** All elements carrying a given `data-dsh-lumen` role. */
function layers(document, role) {
	return document.documentElement.queryAll((el) => el.getAttribute(ACTIVE_ATTR) === role);
}

/**
 * The alpha the veil is actually painted at.
 *
 * The wash used to live in the theme tokens, so every test could read it from
 * the pushed override. It now lives on one element (`data-dsh-lumen="veil"`) and
 * the tokens are simply transparent — which is the whole point: translucency on
 * several nested surfaces compounds, and that is what hid the wallpaper.
 */
function veilAlpha(document) {
	const veil = layers(document, "veil")[0];
	if (!veil) return null;
	const parsed = color.parseColor(veil.style.backgroundColor);
	return parsed === null ? null : parsed.a;
}

test("itemToBackground turns a recipe into a gradient plus a stable identity", () => {
	const tuning = { hue: 0, softness: 0.5, grain: 0.35 };
	const a = itemToBackground({ kind: "recipe", ref: "mist", seed: "s1" }, tuning);
	const b = itemToBackground({ kind: "recipe", ref: "mist", seed: "s1" }, tuning);
	assert.equal(a.image, b.image, "the same seed produced a different picture");
	const c = itemToBackground({ kind: "recipe", ref: "mist", seed: "s2" }, tuning);
	assert.notEqual(a.image, c.image, "a different seed produced the same picture");
	assert.ok(a.image.indexOf("gradient") >= 0);
	assert.ok(a.luminance >= 0 && a.luminance <= 1);
	assert.ok(a.complexity >= 0 && a.complexity <= 1);
});

test("itemToBackground wraps custom sources in a url() it cannot escape", () => {
	const url = itemToBackground({ kind: "url", ref: "https://cdn.example.com/a.jpg", seed: "default" }, null);
	assert.equal(url.image, 'url("https://cdn.example.com/a.jpg")');
	const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
	const image = itemToBackground({ kind: "image", ref: png, seed: "default" }, null);
	assert.equal(image.image, `url("${png}")`);
	assert.equal(image.luminance, 0.42, "an undecodable picture should assume a bright-ish value");
});

test("itemToBackground refuses nothing it cannot render, and never throws on junk", () => {
	assert.equal(itemToBackground(null, null), null);
	assert.equal(itemToBackground(undefined, null), null);
});

test("readRawTheme prefers the registered definition over the composed tokens", () => {
	// The whole point: `active.tokens` already contains our own wash, so reading
	// it would feed the wash back into its own input.
	const ctx = createCtx();
	ctx.theme.overrideTokens("someone-else", { "--dsw-alias-bg-base": { light: "rgba(255, 0, 0, 0.5)", dark: "rgba(255, 0, 0, 0.5)" } });
	const raw = readRawTheme(ctx);
	assert.equal(raw.scheme, "dark");
	assert.equal(color.formatColor(raw.base), "rgb(16, 20, 24)", "the composed (washed) colour leaked in");
	assert.equal(raw.id, "dark-default");
});

test("readRawTheme follows the scheme and refuses an unusable snapshot", () => {
	const ctx = createCtx();
	ctx.theme.setPreference("light-default");
	assert.equal(readRawTheme(ctx).scheme, "light");
	assert.equal(readRawTheme({}), null, "a context with no theme service must not throw");
	assert.equal(readRawTheme({ theme: { getTheme: () => ({}) } }), null);
	assert.equal(readRawTheme({ theme: { getTheme: () => ({ themes: [], active: {} }) } }), null);
	assert.equal(
		readRawTheme({ theme: { getTheme: () => ({ themes: [{ id: "x", tokens: "nope" }], active: { id: "x" } }) } }),
		null
	);
});

/**
 * A window whose computed style answers like a browser's.
 *
 * This is the shape the real DSH page has, and the reason the plugin shipped
 * broken: the built-in themes register `tokens: {}`, so the palette exists only
 * as *resolved CSS* on the body. A test that only ever feeds tokens through the
 * theme service cannot see that, which is how 1.0.0 passed 343 tests and showed
 * no wallpaper.
 */
function createPaintedWindow(document, palette) {
	const win = createWindow(document);
	const tokens = {
		"--dsw-alias-label-primary": palette.label,
		"--dsw-specific-sidebar-fill": palette.sidebar
	};
	// Only present when the shell actually publishes them: the degrade path
	// (a theme that ships no quiet labels) has to be reachable from here too.
	if (palette.secondary) tokens["--dsw-alias-label-secondary"] = palette.secondary;
	if (palette.tertiary) tokens["--dsw-alias-label-tertiary"] = palette.tertiary;
	win.getComputedStyle = () => ({
		backgroundColor: palette.background,
		color: palette.label,
		getPropertyValue: (name) => tokens[name] || ""
	});
	return win;
}

test("the palette is read from the painted document when the theme table is empty", () => {
	// The built-in light/dark pair ships `tokens: {}` — this is a faithful
	// stand-in for that, not a contrived edge case.
	const box = createDocument();
	const win = createPaintedWindow(box, { background: "rgb(255, 255, 255)", label: "rgb(17, 17, 17)", sidebar: "rgb(244, 245, 247)" });
	const palette = readPaletteFromDom(box, win);
	assert.ok(palette !== null, "the document palette was not read");
	assert.equal(color.formatColor(palette.base), "rgb(255, 255, 255)");
	assert.equal(color.formatColor(palette.label), "rgb(17, 17, 17)");
	assert.equal(color.formatColor(palette.sidebar), "rgb(244, 245, 247)");
	assert.equal(palette.scheme, "light");
	// No document (headless), or no computed style: not an error, just null.
	assert.equal(readPaletteFromDom(null, win), null);
	assert.equal(readPaletteFromDom(box, createWindow(box)), null);
});

test("a theme with empty tokens still gets a wash, so the wallpaper is visible", () => {
	const box = createDocument();
	const win = createPaintedWindow(box, { background: "rgb(255, 255, 255)", label: "rgb(17, 17, 17)", sidebar: "rgb(244, 245, 247)" });
	const ctx = createCtx();
	// Both built-in definitions lose their tokens, exactly like DSH's own pair.
	for (const def of ctx.theme.defs) def.tokens = {};
	const store = createStore({ apiPath: "/lumen/api", storage: createStorage(), fetchImpl: null });
	const engine = createEngine({ ctx, store, document: box, window: win });

	engine.start();

	assert.ok(ctx.theme.pushes.length > 0, "no wash was published — the app would stay opaque and hide the wallpaper");
	const push = ctx.theme.pushes[ctx.theme.pushes.length - 1];
	const alpha = veilAlpha(box);
	assert.ok(alpha !== null && alpha > 0 && alpha < 1, `the canvas was not made translucent (alpha ${alpha})`);
	assert.equal(engine.inspect().washed, true, "the engine did not report a live wash");
	engine.dispose();
	assert.equal(engine.inspect().washed, false, "the wash outlived the engine");
});

test("start installs the layer stack in the order that keeps it behind the app", () => {
	const env = makeEngine();
	env.engine.start();
	const { document } = env;

	assert.ok(document.getElementById(STYLE_ID) !== null, "the stylesheet was not injected");
	assert.equal(layers(document, "root").length, 1);
	assert.equal(layers(document, "bleed").length, 1);
	assert.equal(layers(document, "slot-0").length, 1);
	assert.equal(layers(document, "slot-1").length, 1);
	assert.equal(layers(document, "grain").length, 1);
	assert.equal(layers(document, "veil").length, 1);

	// Prepended, not appended: `z-index: -1` only puts it behind the shell if it
	// is the first painted sibling of the app root.
	assert.equal(document.body.firstChild.getAttribute(ACTIVE_ATTR), "root");
	assert.equal(document.documentElement.getAttribute("data-dsh-lumen-active"), "1");

	const root = layers(document, "root")[0];
	const roles = root.childNodes.map((child) => child.getAttribute(ACTIVE_ATTR));
	assert.deepEqual(roles, ["bleed", "slot-0", "slot-1", "veil", "grain"]);

	env.engine.dispose();
});

test("the wash overrides exactly two tokens and leaves the rest of the theme alone", () => {
	const env = makeEngine();
	env.engine.start();
	assert.equal(env.theme.pushes.length, 1, "the wash should be pushed once on first paint");
	const push = env.theme.pushes[0];
	assert.deepEqual(Object.keys(push.tokens).sort(), ["--dsw-alias-bg-base", "--dsw-specific-sidebar-fill"]);
	// The surfaces are handed over *transparent*, and the tint lives on the veil.
	// Putting the alpha in the token is what compounded across the shell's
	// nested surfaces and left the wallpaper invisible behind them.
	for (const name of ["--dsw-alias-bg-base", "--dsw-specific-sidebar-fill"]) {
		assert.equal(push.tokens[name].dark, "transparent", `${name} was not handed over`);
	}
	const veil = color.parseColor(layers(env.document, "veil")[0].style.backgroundColor);
	const base = color.parseColor(DARK_TOKENS["--dsw-alias-bg-base"]);
	assert.equal(veil.r, base.r, "the veil is not the theme's own colour");
	assert.equal(veil.g, base.g);
	assert.equal(veil.b, base.b);
	assert.ok(veil.a > 0 && veil.a < 1, "the veil must be translucent");
	env.engine.dispose();
});

test("the wash does not compound across repaints", () => {
	// The failure this pins: the engine reads the theme, washes it, and pushes
	// the result. If the next read sees the *washed* value, the canvas darkens a
	// little more every time anything repaints — a slow, invisible drift that
	// only becomes obvious after a long session of dragging sliders.
	const env = makeEngine();
	env.engine.start();
	const first = veilAlpha(env.document);
	for (let i = 0; i < 12; i += 1) {
		env.store.update((draft) => {
			draft.tuning = { ...draft.tuning, hue: (i + 1) * 7 };
			return draft;
		});
		env.engine.render();
	}
	const last = veilAlpha(env.document);
	assert.equal(last, first, `the wash drifted from ${first} to ${last} over 12 repaints`);
	env.engine.dispose();
});

test("a new picture cross-fades, a tuning change does not", () => {
	const env = makeEngine();
	env.engine.start();
	const slotA = layers(env.document, "slot-0")[0];
	const slotB = layers(env.document, "slot-1")[0];
	const visible = () => (slotA.style.opacity === "1" ? "slot-0" : slotB.style.opacity === "1" ? "slot-1" : "none");
	const first = visible();
	assert.notEqual(first, "none", "nothing was painted");

	// A parameter move repaints the same slot: cross-fading here would turn a
	// slider drag into a strobe.
	env.store.update((draft) => {
		draft.tuning = { ...draft.tuning, softness: 0.8 };
		return draft;
	});
	env.engine.render();
	assert.equal(visible(), first, "a tuning change cross-faded");

	// A different picture does cross-fade, onto the other slot.
	env.store.update((draft) => {
		draft.single = { ...draft.single, ref: "mist" };
		return draft;
	});
	env.engine.render();
	assert.notEqual(visible(), first, "a new picture did not cross-fade");
	env.engine.dispose();
});

test("a rotation step cross-fades and advances the cursor", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.playlist = [
			{ id: "r1", kind: "recipe", ref: "mist", seed: "s1" },
			{ id: "r2", kind: "recipe", ref: "mist", seed: "s2" },
			{ id: "r3", kind: "recipe", ref: "mist", seed: "s3" }
		];
		draft.mode = "rotation";
		draft.schedule = { ...draft.schedule, order: "sequential" };
		return draft;
	});
	env.engine.start();
	const seen = [env.store.getState().cursor];
	for (let i = 0; i < 3; i += 1) {
		env.engine.rotate("manual");
		seen.push(env.store.getState().cursor);
	}
	assert.deepEqual(seen.slice(0, 4), [0, 1, 2, 0], `sequential rotation walked ${seen.join(",")}`);
	env.engine.dispose();
});

test("shuffle visits every entry before repeating one", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.playlist = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: "recipe", ref: "mist", seed: `s${i}` }));
		draft.mode = "rotation";
		draft.schedule = { ...draft.schedule, order: "shuffle" };
		return draft;
	});
	env.engine.start();
	const visited = [];
	for (let i = 0; i < 5; i += 1) {
		env.engine.rotate("manual");
		visited.push(env.store.getState().cursor);
	}
	assert.equal(new Set(visited).size, 5, `shuffle repeated before exhausting the list: ${visited.join(",")}`);
	env.engine.dispose();
});

test("the readability floor raises the wash over a bright picture and is reported", () => {
	const env = makeEngine();
	// A light recipe behind a dark theme, with the user asking for a thin wash.
	env.store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "mist" };
		draft.wash = { ...draft.wash, opacity: 0.2, autoDim: false, readability: true };
		return draft;
	});
	env.engine.start();
	const pushed = veilAlpha(env.document);
	assert.ok(pushed > 0.2, `a bright picture was washed at only ${pushed}`);
	assert.ok(env.engine.inspect().requiredAlpha > 0.2, "the raised requirement was not reported for the panel");
	env.engine.dispose();
});

test("turning the readability floor off honours the user's alpha exactly", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "mist" };
		draft.wash = { ...draft.wash, opacity: 0.2, autoDim: false, readability: false };
		return draft;
	});
	env.engine.start();
	assert.equal(veilAlpha(env.document), 0.2);
	assert.equal(env.engine.inspect().requiredAlpha, 0);
	env.engine.dispose();
});

test("autoDim lifts the wash on a busier picture", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		// The brightest built-in (complexity 0.6) against the calmest one (0.2):
		// this is the pair the automatic lift exists for — a picture with a sunset
		// sky behind it against a pale mist.
		draft.single = { ...draft.single, kind: "recipe", ref: "whale-sunset" };
		draft.wash = { ...draft.wash, opacity: 0.3, autoDim: true, readability: false };
		return draft;
	});
	env.engine.start();
	const plain = veilAlpha(env.document);
	env.store.update((draft) => {
		draft.single = { ...draft.single, ref: "mist" }; // complexity 0.2
		return draft;
	});
	env.engine.render();
	const busy = plain;
	const calm = veilAlpha(env.document);
	assert.ok(busy > calm, `the busier picture got the lighter wash (${busy} vs ${calm})`);
	env.engine.dispose();
});

test("the grain tile is generated, generated surfaces take it whole, pictures take half", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.tuning = { ...draft.tuning, grain: 1 };
		// Pinned, not inherited: the default wallpaper is one of the bundled
		// illustrations now, so a test that reads "whatever is current" would be
		// measuring a picture in the branch meant to be the generated baseline.
		draft.single = { ...draft.single, kind: "recipe", ref: "mist", seed: "default" };
		return draft;
	});
	env.engine.start();
	const grain = layers(env.document, "grain")[0];
	const recipeOpacity = Number(grain.style.opacity);
	assert.ok(recipeOpacity > 0, "grain was not applied to a recipe");

	// A bundled illustration is a picture even though it is a built-in, so it
	// follows the same rule a user's own photo does.
	env.store.update((draft) => {
		draft.single = { ...draft.single, kind: "recipe", ref: "whale-sunset", seed: "default" };
		return draft;
	});
	env.engine.render();
	const photoOpacity = Number(layers(env.document, "grain")[0].style.opacity);
	assert.ok(photoOpacity < recipeOpacity, "a picture got the full grain strength");

	// A gradient is a generated surface with no texture of its own — half grain
	// would be a rule about "things that are not recipes" rather than about
	// "things that already have texture".
	env.store.update((draft) => {
		draft.single = { ...draft.single, kind: "gradient", ref: "linear-gradient(90deg, #101010 0%, #202020 100%)" };
		return draft;
	});
	env.engine.render();
	const gradientOpacity = Number(layers(env.document, "grain")[0].style.opacity);
	assert.equal(gradientOpacity, recipeOpacity, "a gradient should get the full grain strength");
	env.engine.dispose();
});

test("the blur fit adds a bleed layer and the other fits do not", () => {
	const env = makeEngine();
	env.engine.start();
	const bleed = () => layers(env.document, "bleed")[0];
	assert.equal(bleed().style.opacity, "0", "cover fit should not bleed");

	env.store.update((draft) => {
		draft.wash = { ...draft.wash, fit: "blur", blur: 20 };
		return draft;
	});
	env.engine.render();
	assert.equal(bleed().style.opacity, "1");
	assert.ok(String(bleed().style.filter).indexOf("blur") === 0, `bleed filter was ${bleed().style.filter}`);
	assert.ok(String(bleed().style.filter).indexOf("68px") >= 0, "the bleed blur should exceed the slot blur");
	env.engine.dispose();
});

test("a theme change repaints from the raw theme, without a transition", () => {
	const env = makeEngine();
	env.engine.start();
	env.theme.setPreference("light-default");
	env.ctx.emitThemeChange();
	env.engine.render(true);
	const washed = color.parseColor(layers(env.document, "veil")[0].style.backgroundColor);
	assert.equal(washed.r, 255, "the veil did not follow the theme to light");
	env.engine.dispose();
});

test("a full-window view is given an opaque canvas while the wash is on", () => {
	// The reported bug: the account "usage" page is a body-level dialog that
	// paints itself from `--dsw-alias-bg-base`. The wash makes that token
	// transparent, so the page showed the sidebar underneath and its back button
	// landed on the brand mark. The fix is one rule plus one inherited colour —
	// asserted here because neither is visible until someone opens that page.
	const env = makeEngine();
	env.engine.start();

	const css = env.document.getElementById(STYLE_ID).textContent;
	assert.ok(css.includes(`>header[data-window-drag])`), "the full-window rule is missing from the stylesheet");
	assert.ok(css.includes(`var(${CANVAS_VAR}`), "the rule does not read the opaque canvas colour");

	const canvas = env.document.documentElement.style.getPropertyValue(CANVAS_VAR);
	const parsed = color.parseColor(canvas);
	assert.ok(parsed !== null, `the canvas colour was not published (got ${JSON.stringify(canvas)})`);
	assert.equal(parsed.a, 1, "the canvas colour handed to a full-window view is still translucent");
	// The dark default's canvas, so a stale light value cannot pass this.
	assert.deepEqual([parsed.r, parsed.g, parsed.b], [16, 20, 24]);

	env.theme.setPreference("light-default");
	env.ctx.emitThemeChange();
	env.engine.render(true);
	assert.equal(color.parseColor(env.document.documentElement.style.getPropertyValue(CANVAS_VAR)).r, 255, "the canvas colour did not follow the theme");

	env.engine.dispose();
	assert.equal(env.document.documentElement.style.getPropertyValue(CANVAS_VAR), "", "a stale canvas colour outlived the wash");
});

test("the sidebar gets its own tint and a hairline back while the wash is on", () => {
	// Windows drops the host's `border-right`, and the wash makes both the
	// sidebar and the content transparent — so the two read as one continuous
	// picture. One scrim of the sidebar's own fill plus one hairline restores
	// the panel without putting a second layer in front of the wallpaper.
	const env = makeEngine();
	env.engine.start();

	const css = env.document.getElementById(STYLE_ID).textContent;
	assert.ok(css.includes(`[class*="sidebarCol"]`), "the seam rule is missing from the stylesheet");
	assert.ok(css.includes(`linear-gradient(to bottom,transparent 0`), "the panel does not fade in at the sidebar's own top edge");
	assert.ok(css.includes(`[data-windows-titlebar]`), "the seam would also fire on the darwin layout, which styles its own");

	// The chrome's bottom edge is a hairline on the strip, never a tint: the
	// tinted version lay a light band across the top of the content and ended in
	// a hard edge there, which reads as a fault on a picture.
	const after = css.split(`[class*="frame"]:before`)[1] ?? "";
	const strip = after.slice(0, after.indexOf("}") + 1);
	assert.ok(strip.includes(`box-shadow:inset 0 -1px 0`), "the chrome has no bottom hairline");
	assert.ok(!strip.includes("background"), "the titlebar strip is tinted again, not just ruled");
	assert.ok(strip.includes(`var(${SEAM_VAR})`), "the chrome hairline does not use the seam colour");

	const style = env.document.documentElement.style;
	const panel = color.parseColor(style.getPropertyValue(PANEL_VAR));
	const seam = color.parseColor(style.getPropertyValue(SEAM_VAR));
	assert.ok(panel !== null && panel.a > 0 && panel.a < 1, `the scrim is not translucent (${JSON.stringify(panel)})`);
	// The dark default's sidebar fill, so a canvas-coloured scrim cannot pass.
	assert.deepEqual([panel.r, panel.g, panel.b], [12, 15, 19], "the scrim did not use the sidebar's own fill");
	assert.ok(seam !== null && seam.a > 0 && seam.a < 1, "the hairline is not a hairline");
	assert.ok(seam.r > 200, "the hairline did not follow the label colour");

	env.engine.dispose();
	assert.equal(style.getPropertyValue(PANEL_VAR), "", "a stale scrim outlived the wash");
	assert.equal(style.getPropertyValue(SEAM_VAR), "", "a stale hairline outlived the wash");
});

test("the composer gets a blue rim and a whale girl on its left edge", () => {
	// Both marks are pseudo-elements on the composer card: nothing in the DOM
	// tree, so React cannot reconcile them away. Three things have to hold — the
	// frame is a ring and not a filled card, the sprite hangs on the card's left
	// edge, and both files it names actually ship.
	const fs = require("node:fs");
	const path = require("node:path");
	const env = makeEngine();
	env.engine.start();

	const css = env.document.getElementById(STYLE_ID).textContent;

	// The frame: masked down to a hairline, guarded, and drawn from the theme
	// accent — uneven on purpose, so it reads as light on an edge, not a stroke.
	const frame = css.slice(css.indexOf(`[data-composer-card]:before`));
	const ring = frame.slice(0, frame.indexOf("}") + 1);
	assert.ok(ring.length > 0, "the frame rule is missing from the stylesheet");
	assert.ok(ring.includes(`linear-gradient(150deg`), "the frame is not the corner-to-corner hairline");
	assert.ok(ring.includes(`padding:2.5px`), "the rim is not 2.5px");
	assert.ok(!ring.includes(`repeating-linear-gradient`), "the striped ribbon is back");
	assert.ok(ring.includes(`mask-composite:exclude`), "the frame would paint the whole card");
	assert.ok(ring.includes(`--dsw-alias-state-business-primary`), "the frame ignores the theme accent");
	assert.ok(
		css.lastIndexOf(`@supports`, css.indexOf(`[data-composer-card]:before`)) > 0,
		"the masked frame is not behind an @supports guard"
	);

	// Focus lights the ring up and gives the card a soft accent ring — a
	// `box-shadow` on the card itself, since a shadow can only be replaced.
	const focus = css.slice(css.indexOf(`[data-composer-card]:focus-within{`));
	const glow = focus.slice(0, focus.indexOf("}") + 1);
	assert.ok(glow.includes(`box-shadow:0 0 0 3px`), "focus does not draw a ring");
	assert.ok(glow.includes(`--dsw-alias-state-business-primary`), "the focus ring is not in the accent");

	// The mascot: hanging over the right edge, its drawn border line landing 4px
	// inside the card so her fingertips sit in front of the real border.
	const mascot = css.slice(css.indexOf(`[data-composer-card]:after`));
	const body = mascot.slice(0, mascot.indexOf("}") + 1);
	assert.ok(body.length > 0, "the mascot rule is missing from the stylesheet");
	assert.ok(body.includes(`left:-70px`), "the mascot does not hang over the left edge");
	assert.ok(!body.includes(`bottom:calc(100% - 8px)`), "the mascot is still anchored to the top edge");
	assert.ok(!body.includes(`top:50%`), "the mascot is still vertically centred");
	assert.ok(body.includes(`bottom:2px`), "the sprite does not sit on the card's bottom edge");
	assert.ok(!body.includes(`right:-70px`), "the mascot is still on the right edge");
	assert.ok(body.includes(`62px auto`), "the character is not drawn at its own width");
	assert.ok(body.includes(`pointer-events:auto`), "the mascot cannot be clicked");
	assert.ok(body.includes(`cursor:pointer`), "the mascot does not look clickable");

	// Folding: one attribute on the root, one rule — the character's image is
	// swapped for a tail drawn on its own, and the same click brings her back.
	const folded = css.slice(css.indexOf(`[${MASCOT_STATE_ATTR}="hidden"]`));
	const foldRule = folded.slice(0, folded.indexOf("}", folded.indexOf("{", folded.indexOf("focus-within"))));
	assert.ok(foldRule.length > 0, "the fold state has no rule");
	assert.ok(foldRule.includes(`mascot-tail.webp`), "the folded state does not swap in the tail");
	assert.ok(!foldRule.includes("clip-path"), "the folded state is still a cut-out of the character");
	assert.ok(foldRule.includes(`transform:none`), "the folded tail keeps the character's lift");
	assert.ok(
		css.indexOf(`[${MASCOT_STATE_ATTR}="hidden"]`) > css.indexOf(`[data-composer-card]:focus-within:after`),
		"the fold rule must come after the focus lift, or focus would unfold her"
	);
	assert.ok(
		css.includes(`[data-composer-card]:after{transition:none`),
		"the lift is not switched off under prefers-reduced-motion"
	);

	// The URLs are served by the host's illustration route, which serves this
	// directory and nothing else — so both files must be real files in it.
	for (const name of ["mascot-peek.webp", "mascot-tail.webp"]) {
		assert.ok(css.includes(`/lumen/wallpaper/${name}`), `the stylesheet does not name ${name}`);
		const file = path.join(__dirname, "..", "media", "wallpapers", name);
		assert.equal(fs.existsSync(file), true, `${name} is not in the package`);
		assert.ok(fs.statSync(file).size > 8 * 1024, `${name} is too small to be the artwork`);
	}

	env.engine.dispose();
});

test("the composer decoration can be switched off, and off is a real opt-out", () => {
	// The switch lives in the state so it persists and so the panel can show it;
	// the stylesheet is static, so the state becomes a marker on the root and the
	// composer rules opt out of it. `content:none` — not `visibility` — is what
	// makes it an opt-out: a pseudo that is never generated cannot take a click.
	const env = makeEngine();
	env.engine.start();
	const root = env.document.documentElement;
	assert.equal(env.store.getState().composer, true, "a fresh install must start decorated");
	assert.equal(root.getAttribute(COMPOSER_STATE_ATTR), null, "a fresh state marked the composer off");

	env.store.update((draft) => {
		draft.composer = false;
		return draft;
	});
	env.engine.render(true);
	assert.equal(root.getAttribute(COMPOSER_STATE_ATTR), "off", "the switch did not reach the document");

	const css = env.document.getElementById(STYLE_ID).textContent;
	const off = css.slice(css.indexOf(`[${COMPOSER_STATE_ATTR}="off"]`));
	assert.ok(off.includes("content:none"), "off does not remove the pseudo-elements");
	assert.ok(off.includes(":before") && off.includes(":after"), "only one of the two decorations is removed");
	assert.ok(off.includes("box-shadow:var(--dsw-elevation-soft"), "off keeps our focus glow on the card");

	env.store.update((draft) => {
		draft.composer = true;
		return draft;
	});
	env.engine.render(true);
	assert.equal(root.getAttribute(COMPOSER_STATE_ATTR), null, "switching back on left the marker behind");

	env.engine.dispose();
	env.store.update((draft) => {
		draft.composer = false;
		return draft;
	});
	env.engine.render(true);
	assert.equal(env.document.documentElement.getAttribute(COMPOSER_STATE_ATTR), null, "a stale marker outlived teardown");
});

test("a click belongs to the mascot only inside her strip", () => {
	// The mascot is a pseudo-element, so it has no listener of its own: a click on
	// it arrives as a click on the card. This box is what tells the two apart, and
	// it is the only part of the interaction that can be tested without a browser.
	const card = { top: 100, bottom: 196, height: 96, left: 300, right: 1100, width: 800 };
	const midY = 196 - 2 - MASCOT_H / 2;

	assert.equal(mascotHitTest(card, 300 + 6 - 1, midY), true, "the strip inside the border is not hers");
	assert.equal(mascotHitTest(card, 300 + 6 - MASCOT_W + 4, midY), true, "the outer half of the sprite is not hers");
	assert.equal(mascotHitTest(card, 300 + 6 + 4, midY), false, "the composer's own edge counts as the mascot");
	assert.equal(mascotHitTest(card, 500, midY), false, "the middle of the composer counts as the mascot");
	assert.equal(mascotHitTest(card, 300 - 10, 196 + 20), false, "a click below the card counts as hers");
	assert.equal(mascotHitTest(card, 300 - 40, 100 - MASCOT_H), false, "a click above the sprite counts as hers");
	assert.equal(mascotHitTest(null, 0, 0), false, "a missing rect must not throw or hit");
});

test("dispose leaves no element, no attribute and no token override behind", () => {	const env = makeEngine();
	env.engine.start();
	assert.ok(env.theme.overrides.size > 0, "no wash was published");
	env.engine.dispose();
	assert.equal(layers(env.document, "root").length, 0, "the layer stack survived teardown");
	assert.equal(env.document.getElementById(STYLE_ID), null, "the stylesheet survived teardown");
	assert.equal(env.document.documentElement.getAttribute("data-dsh-lumen-active"), null);
	assert.equal(env.theme.overrides.size, 0, "the wash was left applied to the theme");
});

test("a document-less environment degrades to the token layer instead of throwing", () => {
	// Boot races and a headless harness both land here. The theme must still end
	// up consistent; nothing may pretend a picture was painted.
	const ctx = createCtx();
	const store = createStore({ apiPath: "/lumen/api", storage: null, fetchImpl: null });
	const engine = createEngine({ ctx, store, document: null, window: null });
	engine.start();
	assert.equal(engine.inspect().hasDom, false, "a picture was claimed without a document");
	assert.equal(engine.inspect().active, false);
	assert.ok(ctx.theme.pushes.length > 0, "the wash should still be published without a DOM");
	engine.dispose();
});

test("a body-less document is treated as no document", () => {
	const document = createDocument();
	document.body = null;
	const ctx = createCtx();
	const store = createStore({ apiPath: "/lumen/api", storage: null, fetchImpl: null });
	const engine = createEngine({ ctx, store, document, window: null });
	engine.start();
	assert.equal(engine.inspect().hasDom, false);
	assert.ok(ctx.theme.pushes.length > 0);
	engine.dispose();
});

test("a theme service that throws does not take the render down", () => {
	const env = makeEngine();
	env.ctx.theme.getTheme = () => {
		throw new Error("theme service exploded");
	};
	env.engine.start();
	assert.equal(layers(env.document, "root").length, 1, "the picture layer should still be installed");
	assert.equal(env.theme.pushes.length, 0, "a wash needs a theme colour");
	env.engine.dispose();
});

test("an overrideTokens that throws is survived", () => {
	const env = makeEngine();
	env.theme.overrideTokens = () => {
		throw new Error("nope");
	};
	env.engine.start();
	assert.equal(layers(env.document, "root").length, 1);
	env.engine.dispose();
});

test("rotation is not armed when there is nothing to rotate", () => {
	const env = makeEngine();
	env.engine.start();
	// No playlist: `nextAt` must stay untouched rather than being filled with a
	// trigger for a rotation that can never happen.
	assert.equal(env.store.getState().nextAt, 0);
	env.engine.dispose();
});

test("a paused rotation does not advance on a timer", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.playlist = [
			{ id: "r1", kind: "recipe", ref: "mist", seed: "s1" },
			{ id: "r2", kind: "recipe", ref: "mist", seed: "s2" }
		];
		draft.mode = "rotation";
		draft.paused = true;
		draft.cursor = 0;
		return draft;
	});
	env.engine.start();
	env.engine.tick();
	assert.equal(env.store.getState().cursor, 0, "a paused rotation advanced");
	// A manual step is still allowed: pausing means "don't change it for me".
	env.engine.rotate("manual");
	assert.equal(env.store.getState().cursor, 1);
	env.engine.dispose();
});

test("the engine reports the contrast target it enforces", () => {
	// The panel prints this number; if it ever disagreed with the solver the
	// user would be told a guarantee the code does not make.
	assert.equal(CONTRAST_TARGET, 4.5);
});

test("the wash position reaches the picture layers and leaves the bleed centred", () => {
	const env = makeEngine();
	env.store.update((draft) => {
		draft.wash = { ...draft.wash, fit: "blur", blur: 20, position: "bottom right" };
		return draft;
	});
	env.engine.start();
	const picture = layers(env.document, "slot-0").concat(layers(env.document, "slot-1"));
	assert.equal(picture.length, 2, "both picture layers should exist");
	for (const slot of picture) {
		assert.equal(slot.style.backgroundPosition, "bottom right", "the picture layer ignored the position");
	}
	// The bleed exists to hide the mask edge of the `contain` layer above it, so
	// moving it off-centre would expose exactly the edge it was added to cover.
	assert.equal(layers(env.document, "bleed")[0].style.backgroundPosition, "center", "the bleed layer moved with the picture");
	env.engine.dispose();
});

test("moving the picture repaints even though nothing else about it changed", () => {
	// The render short-circuit keys off the picture's identity and its
	// parameters. `position` changes neither the picture nor its size, so
	// without it in the key the change would be dropped and the wallpaper would
	// silently stay put until something unrelated moved.
	const env = makeEngine();
	env.engine.start();
	assert.equal(layers(env.document, "slot-0")[0].style.backgroundPosition, "center", "the default should be centred");
	env.store.update((draft) => {
		draft.wash = { ...draft.wash, position: "left" };
		return draft;
	});
	env.engine.render();
	for (const role of ["slot-0", "slot-1"]) {
		assert.equal(layers(env.document, role)[0].style.backgroundPosition, "left", `${role} did not repaint`);
	}
	env.engine.dispose();
});

test("a measured picture brightness replaces the assumed constant", () => {
	const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
	const measured = itemToBackground({ kind: "image", ref: png, seed: "default", luminance: 0.98 }, null);
	assert.equal(measured.luminance, 0.98, "the measurement was ignored");
	const assumed = itemToBackground({ kind: "image", ref: png, seed: "default" }, null);
	assert.equal(assumed.luminance, color.NEUTRAL_LUMINANCE, "an unmeasured picture should assume the neutral value");
	// And a nonsense value falls back rather than being trusted.
	for (const bad of [null, "0.9", -1, 2, Number.NaN]) {
		assert.equal(itemToBackground({ kind: "image", ref: png, seed: "default", luminance: bad }, null).luminance, color.NEUTRAL_LUMINANCE);
	}
});

test("a measured bright picture is washed harder than an unmeasured one", () => {
	// The end-to-end claim behind the measurement: the readability floor solves
	// against the real photograph instead of the neutral guess, so a picture
	// that is genuinely near-white gets the wash it actually needs.
	const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
	const env = makeEngine();
	const washFor = (luminance) => {
		env.store.update((draft) => {
			draft.single = { id: "im1", kind: "image", ref: png, seed: "default", luminance };
			draft.wash = { ...draft.wash, opacity: 0.2, autoDim: false, readability: true };
			return draft;
		});
		env.engine.render(true);
		return veilAlpha(env.document);
	};
	const bright = washFor(0.98);
	const dark = washFor(0.02);
	assert.ok(bright > dark, `the brighter picture got the lighter wash (${bright} vs ${dark})`);
	assert.ok(bright > 0.2, "a near-white picture needs more than the user's chosen opacity");
	// `luminance` moves nothing but the wash, so it is deliberately absent from
	// the render key — the picture is the same picture. This asserts the wash is
	// still recomputed on that path, which is the part that would break.
	assert.equal(env.store.getState().single.luminance, 0.02);
	env.engine.dispose();
});

/**
 * The same fixture plus the two quiet labels DSH's own themes publish.
 *
 * Kept separate from the base fixture on purpose: every other test in this file
 * runs against a theme with no quiet labels, which is also the degrade path the
 * guard has to survive.
 */
function createQuietCtx() {
	const ctx = createCtx();
	ctx.theme.defs[0].tokens["--dsw-alias-label-secondary"] = "#cfd3d6";
	ctx.theme.defs[0].tokens["--dsw-alias-label-tertiary"] = "#adb2b8";
	ctx.theme.defs[1].tokens["--dsw-alias-label-secondary"] = "#61666b";
	ctx.theme.defs[1].tokens["--dsw-alias-label-tertiary"] = "#81858c";
	return ctx;
}

test("the wash also moves the quiet labels, because no alpha can save them", () => {
	// Tertiary ships at ~3.7:1 on a solid canvas by design, so the wash can only
	// ever approach a contrast that is still short. The colour is the last lever.
	const env = makeEngine({ ctx: createQuietCtx() });
	env.store.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.2 };
		return draft;
	});
	env.engine.start();
	const push = env.theme.pushes[env.theme.pushes.length - 1];
	assert.deepEqual(Object.keys(push.tokens).sort(), [
		"--dsw-alias-bg-base",
		"--dsw-alias-label-secondary",
		"--dsw-alias-label-tertiary",
		"--dsw-specific-sidebar-fill"
	]);
	for (const name of ["--dsw-alias-bg-base", "--dsw-specific-sidebar-fill"]) {
		assert.equal(push.tokens[name].dark, "transparent", `${name} stopped being transparent`);
	}
	const own = { "--dsw-alias-label-secondary": "#cfd3d6", "--dsw-alias-label-tertiary": "#adb2b8" };
	for (const [token, source] of Object.entries(own)) {
		const pair = push.tokens[token];
		const moved = color.parseColor(pair.dark);
		const original = color.parseColor(source);
		assert.ok(moved !== null, `${token} was not published as a colour`);
		// Only the active scheme's raw value is readable, so both keys carry the
		// solved colour; a theme switch re-solves on the next paint.
		assert.equal(pair.light, pair.dark, `${token} published two different colours`);
		assert.ok(color.relativeLuminance(moved) > color.relativeLuminance(original), `${token} was not lightened on a dark theme`);
		// Published channels are rounded to 8 bits, which is worth a few
		// thousandths of relative luminance; the budget itself is exact.
		assert.ok(color.relativeLuminance(moved) - color.relativeLuminance(original) <= 0.1 + 0.005, `${token} overspent its budget`);
	}
	// The report exists because "still faint" has two very different causes —
	// nothing moved, or the budget ran out — and neither shows on screen.
	const report = env.engine.inspect().quietLabels;
	assert.equal(report.length, 2, "the guard did not report what it moved");
	for (const entry of report) {
		assert.notEqual(entry.from, entry.to, "a reported label did not actually change");
		// Either the target was met, or the budget ran out first — and the report
		// has to say which, or "still faint" stays undiagnosable.
		if (entry.capped) assert.ok(entry.ratio < entry.target, `${entry.token} claims capped but cleared its target`);
		else assert.ok(entry.ratio >= entry.target, `${entry.token} was reported as solved at ${entry.ratio}:1, target ${entry.target}`);
	}
	env.engine.dispose();
	assert.equal(env.theme.overrides.size, 0, "the quiet labels outlived teardown");
	assert.deepEqual(env.engine.inspect().quietLabels, [], "a stale report outlived teardown");
});

test("with the guard off, the quiet labels are left exactly as the theme set them", () => {
	const env = makeEngine({ ctx: createQuietCtx() });
	env.store.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.2, readability: false };
		return draft;
	});
	env.engine.start();
	const push = env.theme.pushes[env.theme.pushes.length - 1];
	assert.deepEqual(Object.keys(push.tokens).sort(), ["--dsw-alias-bg-base", "--dsw-specific-sidebar-fill"]);
	env.engine.dispose();
});

test("the quiet labels are read from the painted document, and never invented", () => {
	// DSH's built-in themes register `tokens: {}`, so the document is the only
	// place these two colours exist. The other half of the contract matters just
	// as much: when the shell does *not* publish them, the palette says `null`
	// and the guard stays out of the way.
	const box = createDocument();
	const full = readPaletteFromDom(box, createPaintedWindow(box, {
		background: "rgb(255, 255, 255)",
		label: "rgb(17, 17, 17)",
		sidebar: "rgb(244, 245, 247)",
		secondary: "rgb(97, 102, 107)",
		tertiary: "rgb(129, 133, 140)"
	}));
	assert.equal(color.formatColor(full.quiet["--dsw-alias-label-secondary"]), "rgb(97, 102, 107)");
	assert.equal(color.formatColor(full.quiet["--dsw-alias-label-tertiary"]), "rgb(129, 133, 140)");

	const bare = readPaletteFromDom(box, createPaintedWindow(box, {
		background: "rgb(255, 255, 255)",
		label: "rgb(17, 17, 17)",
		sidebar: "rgb(244, 245, 247)"
	}));
	assert.deepEqual(Object.values(bare.quiet), [null, null], "a missing token must read as null, not as a made-up colour");
});

test("the quiet labels do not compound across repaints", () => {
	// Same failure the wash itself was fixed for: reading our own output back and
	// deepening it again, one invisible step per repaint.
	const env = makeEngine({ ctx: createQuietCtx() });
	env.store.update((draft) => {
		draft.wash = { ...draft.wash, opacity: 0.2 };
		return draft;
	});
	env.engine.start();
	const first = env.engine.inspect().quietLabels.map((entry) => entry.to);
	assert.ok(first.length > 0, "the fixture did not move anything, so this proves nothing");
	for (let i = 0; i < 10; i += 1) {
		env.store.update((draft) => {
			draft.tuning = { ...draft.tuning, hue: (i + 1) * 7 };
			return draft;
		});
		env.engine.render();
	}
	const last = env.engine.inspect().quietLabels.map((entry) => entry.to);
	assert.deepEqual(last, first, `the quiet labels drifted from ${first} to ${last}`);
	env.engine.dispose();
});
