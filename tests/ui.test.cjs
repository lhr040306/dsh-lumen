"use strict";
/**
 * The stylesheet and the React bridge, plus one structural guard.
 *
 * The guard is the interesting part: "every user-facing string comes from the
 * dictionary" is not enforceable by rendering alone, because a bilingual
 * ternary looks correct in both languages the author speaks. So it is enforced
 * at the source level instead — any CJK literal outside a comment in the UI
 * layer is a string that has escaped the dictionary, and therefore a string no
 * translation test can see and no future language can reach.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { MiniElement, MiniText, createDocument, createStorage } = require("./helpers/minidom.cjs");

const g = globalThis;
g.document = createDocument();
g.HTMLElement = MiniElement;
g.Node = MiniElement;
g.Text = MiniText;

const { PANEL_CSS, PANEL_STYLE_ID, ensurePanelStyle } = require("../src/ui/styles.cjs");
const { createReactPanel, createReactSection } = require("../src/react-bridge.cjs");

const SRC = path.join(__dirname, "..", "src");

/** `/* … *\/` and `//` comments, so a comment may legitimately mention Chinese. */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("every colour in the panel stylesheet is declared in the alias layer", () => {
	// The alias layer is what makes the panel follow a third-party theme without
	// a second stylesheet. Any colour declared *outside* it is a value that
	// silently ignores the theme — so the rule is "one place to look", not "every
	// value must be a token" (the theme contract has no token for, say, the text
	// colour drawn on a brand fill).
	const root = PANEL_CSS.slice(PANEL_CSS.indexOf(".lumen-root{"), PANEL_CSS.indexOf(".lumen-group{"));
	const aliases = new Map(Array.from(root.matchAll(/--lumen-([a-z0-9-]+):([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
	assert.ok(aliases.size >= 10, `only ${aliases.size} aliases were declared`);

	for (const [name, value] of aliases) {
		// Anything that *can* read a theme token must, and must carry a fallback
		// so the standalone preview renders without DSH present.
		if (value.indexOf("var(--dsw-") !== 0) continue;
		assert.ok(value.indexOf(",") > 0, `--lumen-${name} reads a token but has no preview fallback`);
	}

	// Outside the alias layer, no rule may introduce a raw colour.
	const body = PANEL_CSS.slice(PANEL_CSS.indexOf(".lumen-group{"));
	const rawColour = body.match(/(?:^|[\s:(])(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/g);
	assert.equal(rawColour, null, `the stylesheet hardcodes a colour outside the alias layer: ${rawColour}`);
	assert.ok(body.indexOf("var(--lumen-") > 0, "the rules do not use the alias layer at all");

	// And every alias the rules reference must actually be declared.
	const referenced = new Set(Array.from(body.matchAll(/var\(--(lumen-[a-z0-9-]+)/g)).map((m) => m[1].replace(/^lumen-/, "")));
	for (const name of referenced) {
		assert.ok(aliases.has(name), `the rules use --lumen-${name}, which is never declared`);
	}
});

test("every class the panel styles is namespaced", () => {
	// The panel renders inside a settings section the host owns, so an
	// unprefixed `.card` or `.row` is a collision waiting to happen. State
	// modifiers (`is-on`, `is-current`) are exempt: they only ever appear
	// compound, on an element that already carries an `lumen-` class, so they
	// cannot match anything of the host's on their own.
	const classes = Array.from(PANEL_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)).map((m) => m[1]);
	assert.ok(classes.length > 20, `only ${classes.length} classes were found`);
	for (const name of classes) {
		assert.ok(name.startsWith("lumen-") || name.startsWith("is-"), `the class .${name} is neither namespaced nor a state modifier`);
	}
	// A modifier must never be selected on its own, or it stops being scoped.
	for (const match of PANEL_CSS.matchAll(/(^|[},])\s*\.(is-[\w-]+)/g)) {
		assert.fail(`.${match[2]} is selected without an lumen- ancestor: ${match[0]}`);
	}
});

test("the stylesheet is injected once, into the head", () => {
	const document = createDocument();
	ensurePanelStyle(document);
	ensurePanelStyle(document);
	ensurePanelStyle(document);
	const found = document.documentElement.queryAll((el) => el.id === PANEL_STYLE_ID);
	assert.equal(found.length, 1, "the stylesheet was injected more than once");
	assert.equal(found[0].tagName, "STYLE");
	assert.equal(found[0].textContent, PANEL_CSS);
	assert.ok(document.head.contains(found[0]), "the stylesheet was not placed in the head");
});

test("the stylesheet survives a document with no head", () => {
	const document = createDocument();
	document.head = null;
	ensurePanelStyle(document);
	assert.equal(document.documentElement.queryAll((el) => el.id === PANEL_STYLE_ID).length, 1);
});

test("ensurePanelStyle tolerates having no document at all", () => {
	// A teardown race or a headless harness calls this with nothing.
	assert.doesNotThrow(() => ensurePanelStyle(null));
	assert.doesNotThrow(() => ensurePanelStyle(undefined));
	assert.doesNotThrow(() => ensurePanelStyle({}));
});

/** A minimal stand-in for React's hook surface. */
function createReact() {
	const state = { refs: [], effects: [], cleanups: [] };
	return {
		state,
		useRef: () => {
			const ref = { current: null };
			state.refs.push(ref);
			return ref;
		},
		useEffect: (fn) => {
			// The component returns its cleanup; the harness runs it on unmount.
			state.effects.push(() => {
				const cleanup = fn();
				if (typeof cleanup === "function") state.cleanups.push(cleanup);
			});
		},
		createElement: (type, props, ...children) => {
			if (typeof type === "function") return type(props);
			const el = new MiniElement(type);
			for (const [key, value] of Object.entries(props || {})) {
				if (key === "className") el.className = value;
				else if (key !== "ref") el.setAttribute(key, value);
			}
			for (const child of children) {
				if (child === null || child === undefined) continue;
				if (Array.isArray(child)) for (const c of child) el.appendChild(c);
				else if (typeof child === "object") el.appendChild(child);
				else el.appendChild(new MiniText(child));
			}
			if (props && props.ref) props.ref.current = el;
			return el;
		}
	};
}

test("the React bridge mounts the panel into its container and tears it down", () => {
	const React = createReact();
	let created = 0;
	let destroyed = 0;
	const Component = createReactPanel(React, () => {
		created += 1;
		const el = new MiniElement("div");
		el.className = "lumen-root";
		return {
			el,
			destroy: () => {
				destroyed += 1;
			}
		};
	});

	const tree = Component({});
	assert.equal(created, 0, "the panel was built before the effect ran");
	React.state.effects[0]();
	assert.equal(created, 1);
	assert.equal(tree.childNodes.length, 1, "the panel was not attached to the container");

	React.state.cleanups[0]();
	assert.equal(destroyed, 1, "unmounting did not dispose the panel");
	assert.equal(tree.childNodes.length, 0, "unmounting left the panel node behind");
});

test("the bridge disposes rather than throwing when the container is missing", () => {
	// React can run an effect while `ref.current` is still null (a conditionally
	// rendered container, or a re-mount mid-flight). The panel has already been
	// constructed at that point, so it must be disposed rather than dropped.
	const React = createReact();
	let destroyed = 0;
	const Component = createReactPanel(React, () => ({
		el: new MiniElement("div"),
		destroy: () => {
			destroyed += 1;
		}
	}));
	Component({});
	// Simulate the ref never having attached.
	React.state.refs[0].current = null;
	assert.doesNotThrow(() => React.state.effects[0]());
	assert.equal(destroyed, 1, "a panel built against a missing container was leaked");
});

test("a re-mount does not stack two panels in one slot", () => {
	// React 18 in development runs effects twice; without the explicit child
	// removal the slot would end up holding two panels.
	const React = createReact();
	const Component = createReactPanel(React, () => {
		const el = new MiniElement("div");
		return { el, destroy: () => {} };
	});
	const tree = Component({});
	React.state.effects[0]();
	React.state.cleanups[0]();
	React.state.effects[0]();
	assert.equal(tree.childNodes.length, 1, `the slot holds ${tree.childNodes.length} panels`);
});

test("the section wrapper delegates to the host's slot renderer", () => {
	const React = createReact();
	const calls = [];
	const Section = createReactSection(React, "settings.lumen.item");
	const tree = Section({ renderSlot: (name, props) => { calls.push([name, props]); return new MiniText("slot"); } });
	assert.deepEqual(calls, [["settings.lumen.item", {}]]);
	assert.equal(tree.childNodes.length, 1);

	// With no renderer the wrapper must still produce a valid node rather than
	// calling undefined.
	const bare = Section({});
	assert.equal(bare.className, "lumen-root");
});

test("no user-facing string escapes the dictionary in the UI layer", () => {
	// See the file header: this is the only way to make the rule enforceable.
	const files = ["ui/dom.cjs", "ui/panel.cjs", "ui/styles.cjs", "react-bridge.cjs"];
	let inspected = 0;
	for (const file of files) {
		const source = stripComments(fs.readFileSync(path.join(SRC, file), "utf8"));
		const lines = source.split(/\r?\n/);
		lines.forEach((line, index) => {
			inspected += 1;
			const match = line.match(/[\u3400-\u9fff]+/);
			assert.equal(
				match,
				null,
				`${file}:${index + 1} has a hardcoded Chinese literal (${match && match[0]}); move it into src/i18n.cjs`
			);
		});
	}
	assert.ok(inspected > 500, `only ${inspected} lines were inspected`);
});
