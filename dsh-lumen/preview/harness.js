/**
 * The preview's platform harness.
 *
 * WHAT THIS FILE PRETENDS TO BE
 *
 * `lib/client.js` is a cordis loader entry: it expects a shell to provide
 * `window.__ModuleLoader__`, a module table containing `react`, and a context
 * carrying the `theme`, `slots` and `locale` services. None of that exists in a
 * bare browser tab, so this file supplies all four — and nothing else. The
 * plugin under it is the shipped bundle, unmodified.
 *
 * The order is load-bearing and is why this is a separate file from
 * `preview.js`:
 *
 *   1. harness.js   defines __ModuleLoader__, installs the clock shift
 *   2. ../lib/client.js   calls __ModuleLoader__.load({ id, factory })
 *   3. preview.js   builds a ctx and calls the factory's `apply`
 *
 * THE CLOCK SHIFT, AND WHY IT PATCHES `Date.now` AND NOTHING ELSE
 *
 * The rotation scheduler is the innovation this preview exists to show, and
 * its whole subject matter is the passage of wall-clock time: fire on the hour,
 * fire daily at 07:30, catch up after the machine slept. Waiting for a real
 * hour to pass is not a demo.
 *
 * The naive patch is to replace the clock wholesale, which immediately
 * desynchronises: `nextTriggerAt` builds a timestamp with
 * `new Date(y, m, d, H, M).getTime()` and compares it against `Date.now()`, so a
 * shift applied to one side and not the other produces a delay that is off by
 * the shift — the countdown reads "in 2 hours" forever.
 *
 * The correct move follows from one observation: a constant shift is a
 * relabelling of the same timeline, and the local time zone is unchanged. So
 * only the *source* of "now" needs to move. `new Date(ts)` takes a timestamp
 * that the plugin itself produced (already in shifted space) and must not be
 * touched; `new Date(y, m, d, ...)` builds a timestamp from shifted wall-clock
 * components and must not be touched either; the getters operate on shifted
 * values and must not be touched. Only two expressions mean "the present
 * instant" — `Date.now()` and `new Date()` with no arguments — and shifting
 * exactly those keeps every difference, countdown and timer delay exact, at any
 * offset. That is why there is no monkey-patching of the scheduler below.
 *
 * `RealDate` is kept so the preview chrome can show the unshifted time next to
 * the shifted one; confusing those two would make the shift look like a bug.
 */

(function () {
	"use strict";

	const RealDate = Date;
	const listeners = new Set();
	let offsetMs = 0;

	/** A `Date` whose only difference from the real one is what "now" means. */
	class ShiftedDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(RealDate.now() + offsetMs);
			else super(...args);
		}
		static now() {
			return RealDate.now() + offsetMs;
		}
	}

	// `class X extends Date` is a *subclass*, and code that reads `Date.name`
	// (or a stack trace) should not learn about the preview from it.
	try {
		Object.defineProperty(ShiftedDate, "name", { value: "Date", configurable: true });
	} catch {}
	window.Date = ShiftedDate;

	// ── mini React ───────────────────────────────────────────────────────────
	/**
	 * Hooks + a one-shot renderer, sized to exactly what `react-bridge.cjs`
	 * uses: `useRef`, `useEffect`, `createElement`.
	 *
	 * A real React would be the wrong tool here for a boring reason — the
	 * preview is a plain `<script>` page with no build step, and adding one to
	 * demo an 800-line panel is not a trade worth making. What matters is that
	 * the *bridge* runs for real: the section component is rendered through
	 * `slots.renderSlot`, and `createReactPanel`'s effect is what constructs the
	 * panel, exactly as inside DSH. The shell's settings panel is therefore the
	 * shipped panel reached by the shipped path, not a bypass.
	 */
	const renderer = (function createRenderer() {
		let hookCells = null;
		let hookCursor = 0;
		let collecting = null;
		let mountSeq = 0;

		function createElement(type, props, ...children) {
			const merged = {};
			if (props !== null && props !== undefined) {
				for (const key of Object.keys(props)) merged[key] = props[key];
			}
			const kids = children.length === 0 ? merged.children : children.length === 1 ? children[0] : children;
			if (kids !== undefined) merged.children = kids;
			return { $$lumen: true, type, props: merged };
		}

		function useRef(initial) {
			const cell = hookCells[hookCursor] || (hookCells[hookCursor] = {});
			hookCursor += 1;
			if (!Object.prototype.hasOwnProperty.call(cell, "ref")) cell.ref = { current: initial };
			return cell.ref;
		}

		function useEffect(fn, deps) {
			const cell = hookCells[hookCursor] || (hookCells[hookCursor] = {});
			hookCursor += 1;
			cell.deps = deps;
			collecting.push({ fn, deps, cell });
		}

		function isVNode(value) {
			return value !== null && typeof value === "object" && value.$$lumen === true;
		}

		function applyProps(el, props) {
			for (const name of Object.keys(props)) {
				if (name === "children" || name === "ref" || name === "key") continue;
				const value = props[name];
				if (value === undefined || value === null) continue;
				if (name === "className" || name === "class") {
					// The *property*, not the attribute — which is what React does,
					// and the difference is observable: a DOM implementation is free
					// to keep `className` and the `class` attribute in separate
					// storage, and the test double does exactly that.
					el.className = String(value);
					continue;
				}
				if (name === "style" && typeof value === "object") {
					for (const prop of Object.keys(value)) {
						try {
							el.style[prop] = value[prop];
						} catch {}
					}
					continue;
				}
				if (name === "html" ) {
					el.innerHTML = String(value);
					continue;
				}
				if (typeof value === "function" && name.slice(0, 2) === "on") {
					el.addEventListener(name.slice(2).toLowerCase(), value);
					continue;
				}
				if (value === true) {
					el.setAttribute(name, "");
					continue;
				}
				if (value === false) continue;
				el.setAttribute(name, String(value));
			}
		}

		/**
		 * Render one vnode tree into a container.
		 * @param {object} vnode
		 * @param {Element} container
		 * @param {string} key stable instance key, so hooks survive a re-render
		 * @param {Array} cleanups effect cleanups are pushed here for `unmount`
		 */
		/** Hook cells per component instance, keyed by the render path. */
		const instanceCells = new Map();

		function render(vnode, container, key, cleanups) {
			if (vnode === null || vnode === undefined || typeof vnode === "boolean") return;
			if (Array.isArray(vnode)) {
				vnode.forEach((child, index) => render(child, container, `${key}[${index}]`, cleanups));
				return;
			}
			if (typeof vnode === "string" || typeof vnode === "number") {
				container.appendChild(document.createTextNode(String(vnode)));
				return;
			}
			if (!isVNode(vnode)) return;
			const type = vnode.type;
			const props = vnode.props || {};

			if (typeof type === "function") {
				const cells = (instanceCells.get(key) || []).slice();
				const previousCells = hookCells;
				const previousCursor = hookCursor;
				const previousCollecting = collecting;
				hookCells = cells;
				hookCursor = 0;
				collecting = [];
				let output;
				let effects;
				try {
					output = type(props);
				} finally {
					// Restored in `finally` so a throwing component cannot leave a
					// half-installed hook context behind for its siblings.
					effects = collecting;
					instanceCells.set(key, hookCells);
					hookCells = previousCells;
					hookCursor = previousCursor;
					collecting = previousCollecting;
				}
				render(output, container, `${key}/${type.name || "fn"}`, cleanups);
				// Effects run after the subtree is committed, which is what the
				// bridge depends on: the effect reads `ref.current`, and the ref is
				// only assigned once the `div` below it has been created.
				for (const effect of effects) {
					let result;
					try {
						result = effect.fn();
					} catch (error) {
						console.error("[preview] effect threw:", error);
					}
					if (typeof result === "function") cleanups.push(result);
				}
				return;
			}

			if (typeof type === "string") {
				const el = document.createElement(type);
				applyProps(el, props);
				if (props.ref !== undefined && props.ref !== null && typeof props.ref === "object") props.ref.current = el;
				render(props.children, el, `${key}/${type}`, cleanups);
				container.appendChild(el);
				return;
			}

			// A fragment-ish node: render children without a wrapper.
			if (props.children !== undefined) render(props.children, container, `${key}/frag`, cleanups);
		}

		return {
			createElement,
			useRef,
			useEffect,
			/** Mount a component into a container; returns an unmount function. */
			mount(type, props, container) {
				const key = `mount${(mountSeq += 1)}`;
				const cleanups = [];
				render(createElement(type, props), container, key, cleanups);
				return function unmount() {
					for (let i = cleanups.length - 1; i >= 0; i -= 1) {
						try {
							cleanups[i]();
						} catch (error) {
							console.error("[preview] cleanup threw:", error);
						}
					}
					cleanups.length = 0;
					instanceCells.delete(key);
					while (container.firstChild) container.removeChild(container.firstChild);
				};
			}
		};
	})();

	// ── theme service ────────────────────────────────────────────────────────
	/**
	 * The token values are lifted verbatim from a shipped DSH theme pack so the
	 * panel and the wash are exercised against real numbers rather than
	 * invented ones. `aurora` and `mist` are derived from `abyss` and `ivory` by
	 * overriding the hue-carrying tokens: the point of having three is to show
	 * that a wash solved for one palette is re-solved for the next.
	 */
	const DARK_TOKENS = {
		"--dsw-alias-bg-base": "#111317",
		"--dsw-alias-bg-layer-1": "#1a1c21",
		"--dsw-alias-bg-layer-2": "rgba(42, 44, 50, 0.92)",
		"--dsw-alias-bg-layer-3": "#212429",
		"--dsw-alias-bg-overlay": "rgba(42, 44, 50, 0.92)",
		"--dsw-alias-label-primary": "#edf0f7",
		"--dsw-alias-label-secondary": "#bec1c7",
		"--dsw-alias-label-tertiary": "#a1a4aa",
		"--dsw-alias-brand-primary": "#a093fb",
		"--dsw-alias-brand-text": "#0d0f14",
		"--dsw-alias-button-primary-fill": "#a093fb",
		"--dsw-alias-button-primary-hover": "#b6aeff",
		"--dsw-alias-border-l1": "rgba(255, 255, 255, 0.062)",
		"--dsw-alias-border-l2": "rgba(255, 255, 255, 0.098)",
		"--dsw-alias-border-l3": "rgba(255, 255, 255, 0.142)",
		"--dsw-alias-interactive-bg-hover": "rgba(160, 147, 251, 0.15)",
		"--dsw-alias-interactive-bg-active": "rgba(160, 147, 251, 0.24)",
		"--dsw-focus-ring-color": "#a093fb",
		"--dsw-alias-state-success-primary": "#6ed889",
		"--dsw-alias-state-warn-primary": "#fac053",
		"--dsw-alias-state-error-primary": "#ef675c",
		"--dsw-alias-markdown-code-block": "rgba(1, 2, 4, 0.42)",
		"--dsw-alias-markdown-inline-code": "rgba(255, 255, 255, 0.085)",
		"--dsw-alias-scrollbar-bg-l1": "rgba(255, 255, 255, 0.09)",
		"--dsw-alias-scrollbar-hover-l1": "rgba(255, 255, 255, 0.2)",
		"--dsw-specific-sidebar-fill": "#0f1114",
		"--dsw-specific-sidebar-nav-item-active": "rgba(255, 255, 255, 0.085)",
		"--dsw-specific-sidebar-nav-item-hover": "rgba(255, 255, 255, 0.05)",
		"--dsw-specific-input-major": "rgba(255, 255, 255, 0.075)",
		"--dsw-specific-bubble": "rgba(31, 33, 38, 0.92)",
		"--dsw-specific-bubble-highlight": "rgba(160, 147, 251, 0.16)"
	};

	const LIGHT_TOKENS = {
		"--dsw-alias-bg-base": "#f3f0e7",
		"--dsw-alias-bg-layer-1": "rgba(255, 253, 246, 0.72)",
		"--dsw-alias-bg-layer-2": "rgba(255, 253, 246, 0.94)",
		"--dsw-alias-bg-layer-3": "#fbf7ee",
		"--dsw-alias-bg-overlay": "rgba(255, 255, 255, 0.92)",
		"--dsw-alias-label-primary": "#272623",
		"--dsw-alias-label-secondary": "#52504d",
		"--dsw-alias-label-tertiary": "#5e5d5a",
		"--dsw-alias-brand-primary": "#1d6cc1",
		"--dsw-alias-brand-text": "#ffffff",
		"--dsw-alias-button-primary-fill": "#1d6cc1",
		"--dsw-alias-button-primary-hover": "#0d5cab",
		"--dsw-alias-border-l1": "rgba(14, 13, 10, 0.1)",
		"--dsw-alias-border-l2": "rgba(14, 13, 10, 0.14)",
		"--dsw-alias-border-l3": "rgba(14, 13, 10, 0.185)",
		"--dsw-alias-interactive-bg-hover": "rgba(29, 108, 193, 0.1)",
		"--dsw-alias-interactive-bg-active": "rgba(29, 108, 193, 0.17)",
		"--dsw-focus-ring-color": "#1d6cc1",
		"--dsw-alias-state-success-primary": "#007935",
		"--dsw-alias-state-warn-primary": "#896100",
		"--dsw-alias-state-error-primary": "#b6322d",
		"--dsw-alias-markdown-code-block": "rgba(14, 13, 10, 0.045)",
		"--dsw-alias-markdown-inline-code": "rgba(29, 108, 193, 0.17)",
		"--dsw-alias-scrollbar-bg-l1": "rgba(14, 13, 10, 0.2)",
		"--dsw-alias-scrollbar-hover-l1": "rgba(14, 13, 10, 0.36)",
		"--dsw-specific-sidebar-fill": "#f1ede5",
		"--dsw-specific-sidebar-nav-item-active": "rgba(14, 13, 10, 0.075)",
		"--dsw-specific-sidebar-nav-item-hover": "rgba(14, 13, 10, 0.045)",
		"--dsw-specific-input-major": "#f6f2ea",
		"--dsw-specific-bubble": "#f9f5ec",
		"--dsw-specific-bubble-highlight": "rgba(29, 108, 193, 0.1)"
	};

	/** Teal-hued variants, so switching themes visibly changes the wash solve. */
	const AURORA_TOKENS = {
		...DARK_TOKENS,
		"--dsw-alias-bg-base": "#0f1415",
		"--dsw-alias-bg-layer-1": "#181e1f",
		"--dsw-alias-label-primary": "#eaf2f3",
		"--dsw-alias-label-secondary": "#bbc3c3",
		"--dsw-alias-label-tertiary": "#9ea6a6",
		"--dsw-alias-brand-primary": "#00bbc5",
		"--dsw-alias-button-primary-fill": "#00bbc5",
		"--dsw-alias-interactive-bg-hover": "rgba(0, 187, 197, 0.15)",
		"--dsw-focus-ring-color": "#00bbc5",
		"--dsw-specific-sidebar-fill": "#0c1112"
	};

	const MIST_TOKENS = {
		...LIGHT_TOKENS,
		"--dsw-alias-bg-base": "#e3edf4",
		"--dsw-alias-bg-layer-1": "rgba(240, 248, 255, 0.62)",
		"--dsw-alias-label-primary": "#1b2730",
		"--dsw-alias-label-secondary": "#41525e",
		"--dsw-alias-label-tertiary": "#4d5d69",
		"--dsw-alias-brand-primary": "#0f6f8c",
		"--dsw-alias-button-primary-fill": "#0f6f8c",
		"--dsw-specific-sidebar-fill": "#dbe8f0"
	};

	const THEMES = [
		{ id: "abyss", label: "Abyss", colorScheme: "dark", tokens: DARK_TOKENS },
		{ id: "aurora", label: "Aurora", colorScheme: "dark", tokens: AURORA_TOKENS },
		{ id: "ivory", label: "Ivory", colorScheme: "light", tokens: LIGHT_TOKENS },
		{ id: "mist", label: "Mist", colorScheme: "light", tokens: MIST_TOKENS }
	];

	function createThemeService() {
		/** source -> the token overrides that source currently owns. */
		const overrides = new Map();
		const themeListeners = new Set();
		let preference = "abyss";
		let publishTarget = null;

		const byId = (id) => THEMES.find((theme) => theme.id === id) || THEMES[0];

		function systemPreference() {
			const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
			return dark ? "abyss" : "ivory";
		}

		function resolvedId() {
			return preference === "system" ? systemPreference() : byId(preference).id;
		}

		/** The theme's own tokens with every live override layered on. */
		function composedTokens(id) {
			const theme = byId(id);
			const out = { ...theme.tokens };
			for (const tokens of overrides.values()) {
				for (const name of Object.keys(tokens)) {
					const pair = tokens[name];
					const value = pair !== null && typeof pair === "object" ? pair[theme.colorScheme] : pair;
					if (typeof value === "string") out[name] = value;
				}
			}
			return out;
		}

		let visible = {};

		/**
		 * Write the composed tokens onto the document element.
		 *
		 * The engine reads `getTheme().themes[].tokens` (the RAW definition) and
		 * never `active.tokens`, deliberately, so feeding the wash back into its
		 * own input is impossible. Publishing to CSS is the other side of that
		 * contract: what the page paints is always the composed value.
		 */
		function publish() {
			const id = resolvedId();
			const theme = byId(id);
			visible = composedTokens(id);
			if (publishTarget === null) return;
			for (const name of Object.keys(visible)) publishTarget.style.setProperty(name, visible[name]);
			publishTarget.setAttribute("data-dsw-scheme", theme.colorScheme);
			publishTarget.setAttribute("data-dsw-theme", id);
		}

		function announce() {
			for (const listener of Array.from(themeListeners)) {
				try {
					listener();
				} catch (error) {
					console.error("[preview] theme listener threw:", error);
				}
			}
		}

		return {
			/** The DOM element the composed tokens are written to. */
			mount(element) {
				publishTarget = element;
				publish();
			},
			getTheme() {
				const id = resolvedId();
				return {
					preference,
					active: { id, colorScheme: byId(id).colorScheme, tokens: composedTokens(id) },
					themes: THEMES.map((theme) => ({ id: theme.id, label: theme.label, colorScheme: theme.colorScheme, tokens: theme.tokens }))
				};
			},
			/**
			 * Register a token override layer. Returns its disposer, and — like the
			 * host — restores whatever layer it displaced, so the engine's
			 * replace-then-dispose ordering cannot drop a previous wash.
			 */
			overrideTokens(source, tokens) {
				if (typeof source !== "string" || source.length === 0) throw new TypeError("overrideTokens: source must be a non-empty string");
				if (tokens === null || typeof tokens !== "object") throw new TypeError("overrideTokens: tokens must be an object");
				const displaced = overrides.get(source);
				overrides.set(source, tokens);
				publish();
				announce();
				return () => {
					if (overrides.get(source) !== tokens) return;
					if (displaced === undefined) overrides.delete(source);
					else overrides.set(source, displaced);
					publish();
					announce();
				};
			},
			setPreference(next) {
				const wanted = next === "system" ? "system" : byId(next).id;
				if (wanted === preference) return;
				preference = wanted;
				publish();
				announce();
			},
			isDark: () => byId(resolvedId()).colorScheme === "dark",
			/** Raw definition, for the inspector's "raw vs composed" comparison. */
			rawTokens: () => byId(resolvedId()).tokens,
			/** What the page is actually painting, wash included. */
			visibleTokens: () => ({ ...visible }),
			/** Preview-only: count of live override layers. */
			overrideSources: () => Array.from(overrides.keys()),
			onChange(listener) {
				themeListeners.add(listener);
				return () => themeListeners.delete(listener);
			}
		};
	}

	// ── slots + locale services ──────────────────────────────────────────────
	function createSlotsService() {
		/** slot name -> registrations, in registration order. */
		const registry = new Map();
		const slots = {
			/**
			 * cordis defers the callback until the named service exists. Here every
			 * service exists from the start, so "ready" is now — which is the case
			 * this preview is meant to exercise.
			 */
			inject(name, register) {
				if (typeof register !== "function") return () => {};
				return register();
			},
			register(definition, Component) {
				const name = definition && typeof definition.name === "string" ? definition.name : null;
				if (name === null) throw new TypeError("slots.register: definition.name is required");
				const entry = { definition, Component };
				const list = registry.get(name) || [];
				list.push(entry);
				registry.set(name, list);
				return () => {
					const current = registry.get(name);
					if (!current) return;
					const index = current.indexOf(entry);
					if (index !== -1) current.splice(index, 1);
				};
			},
			/** What a section uses to render its declared child slot. */
			renderSlot(name, props) {
				const list = registry.get(name);
				if (list === undefined || list.length === 0) return null;
				// Last registered wins, matching "the newest registration is the
				// visible one" in a slot that holds a single list.
				const entry = list[list.length - 1];
				return renderer.createElement(entry.Component, { ...(props || {}), slotName: name, renderSlot: slots.renderSlot });
			},
			/** Preview-only introspection. */
			names: () => Array.from(registry.keys()),
			count: () => registry.size
		};
		return slots;
	}

	function createLocaleService() {
		const dictionaries = new Map();
		let language = "zh";
		return {
			register(namespace, table) {
				dictionaries.set(namespace, table);
				return () => dictionaries.delete(namespace);
			},
			getLanguage: () => language,
			setLanguage(next) {
				language = next === "en" ? "en" : "zh";
				return language;
			},
			lookup(namespace, language_, key) {
				const table = dictionaries.get(namespace);
				if (table === undefined || table[language_] === undefined) return undefined;
				return table[language_][key];
			},
			namespaces: () => Array.from(dictionaries.keys())
		};
	}

	// ── the module loader double ─────────────────────────────────────────────
	const ReactShim = {
		createElement: renderer.createElement,
		useRef: renderer.useRef,
		useEffect: renderer.useEffect
	};

	const loaded = new Map();
	/** Modules the shell can hand to the plugin. Everything else is refused. */
	function hostRequire(id) {
		if (id === "react") return ReactShim;
		throw new Error(`[preview] the host module table has no entry for ${JSON.stringify(id)}`);
	}

	window.__ModuleLoader__ = {
		load(entry) {
			if (entry === null || typeof entry !== "object" || typeof entry.factory !== "function") {
				throw new TypeError("[preview] __ModuleLoader__.load expects { id, factory }");
			}
			const exports = entry.factory(hostRequire);
			loaded.set(entry.id, exports);
			return exports;
		},
		/** The loader's own table lookup; the bundle uses it for platform seeds. */
		require: hostRequire
	};

	// ── the preview API ─────────────────────────────────────────────────────
	window.__DSH_LUMEN_PREVIEW__ = {
		RealDate,
		/** Current shift, ms. */
		get clockOffset() {
			return offsetMs;
		},
		/** Shift the plugin's notion of "now". Does not touch timers — see README. */
		shiftClock(ms) {
			offsetMs = Number.isFinite(Number(ms)) ? Number(ms) : 0;
			for (const listener of Array.from(listeners)) {
				try {
					listener(offsetMs);
				} catch (error) {
					console.error("[preview] clock listener threw:", error);
				}
			}
			return offsetMs;
		},
		/** Add to the current shift. */
		advanceClock(ms) {
			return window.__DSH_LUMEN_PREVIEW__.shiftClock(offsetMs + (Number(ms) || 0));
		},
		onClockShift(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The exports of a module the loader has been handed. */
		module(id) {
			const found = loaded.get(id);
			if (found === undefined) throw new Error(`[preview] module ${JSON.stringify(id)} was never loaded`);
			return found;
		},
		loadedIds: () => Array.from(loaded.keys()),
		React: ReactShim,
		renderer,
		createThemeService,
		createSlotsService,
		createLocaleService,
		themes: THEMES.map((theme) => ({ id: theme.id, label: theme.label, colorScheme: theme.colorScheme })),
		/** Build a ctx with the three services the plugin injects. */
		createContext() {
			const theme = createThemeService();
			const slots = createSlotsService();
			const locale = createLocaleService();
			const listeners = new Map();
			const effects = [];
			let disposed = false;
			const ctx = {
				theme,
				slots,
				locale,
				on(name, listener) {
					const set = listeners.get(name) || new Set();
					set.add(listener);
					listeners.set(name, set);
					return () => set.delete(listener);
				},
				emit(name, payload) {
					const set = listeners.get(name);
					if (set === undefined) return;
					for (const listener of Array.from(set)) {
						try {
							listener(payload);
						} catch (error) {
							console.error(`[preview] ${name} listener threw:`, error);
						}
					}
				},
				effect(run, label) {
					const result = run();
					effects.push({ dispose: typeof result === "function" ? result : null, label: label || "(unlabelled)" });
					return result;
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					for (let i = effects.length - 1; i >= 0; i -= 1) {
						try {
							if (typeof effects[i].dispose === "function") effects[i].dispose();
						} catch (error) {
							console.error("[preview] effect dispose threw:", error);
						}
					}
					effects.length = 0;
					listeners.clear();
				},
				effectLabels: () => effects.map((effect) => effect.label),
				isDisposed: () => disposed
			};
			return ctx;
		}
	};
})();
