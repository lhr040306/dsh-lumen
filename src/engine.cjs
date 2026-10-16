"use strict";
/**
 * The render engine — everything that touches the page.
 *
 * THE LAYER STACK
 *
 *   <div data-dsh-lumen="root">      position:fixed; inset:0; z-index:-1
 *     <div data-dsh-lumen="bleed">   only in `blur` fit: the same picture, oversized + blurred
 *     <div data-dsh-lumen="slot-0">  picture A   ─┐ exactly one of these is opaque
 *     <div data-dsh-lumen="slot-1">  picture B   ─┘ they cross-fade
 *     <div data-dsh-lumen="grain">   film grain, mix-blend-mode: overlay
 *   </div>
 *
 * It sits at `z-index: -1` behind the application and never receives pointer
 * events, so nothing about the shell's own layout, hit-testing or scrolling
 * changes. For that to be *visible*, the app's canvas must be translucent —
 * which is what the wash below does, and is why a wallpaper plugin is
 * necessarily also a wash plugin.
 *
 * THE WASH, AND WHAT IT IS ALLOWED TO TOUCH
 *
 * The wash replaces the theme's own canvas colour with a translucent version
 * of *the same colour*. It touches exactly two tokens:
 *
 *   --dsw-alias-bg-base            the canvas
 *   --dsw-specific-sidebar-fill    the sidebar pane
 *
 * and deliberately nothing else. A full skin system would also claim the
 * composer and dialog fill tokens, because it wants to control the material of
 * every surface. A wallpaper plugin has no business rewriting the input box.
 * The smaller the token surface, the smaller the blast radius when a future
 * host generation renames something.
 *
 * THE READABILITY FLOOR IS THE ONE THING THE USER CANNOT TURN OFF BY ACCIDENT
 *
 * A wallpaper can destroy text contrast in a way no theme token can prevent:
 * the canvas is washed translucent over an arbitrary picture. So the wash alpha
 * is solved against WCAG AA (`color.alphaForContrast`), and the *effective*
 * alpha is the larger of the user's choice and the solved minimum. The panel
 * shows the difference rather than hiding it — a slider that silently reads
 * 30% while rendering 62% is exactly the kind of lie this project avoids.
 */

const { renderRecipe } = require("./wallpapers.cjs");
const {
	parseColor,
	withAlpha,
	formatColor,
	alphaForContrast,
	estimateImageLuminance,
	relativeLuminance,
	NEUTRAL_LUMINANCE
} = require("./color.cjs");
const { currentItem, isSafeBackgroundImage } = require("./state.cjs");
const { normalizeSchedule, planResume, stepCursor, upcomingTriggers } = require("./scheduler.cjs");

/** Attribute marking the root element while a wallpaper is live. */
const ACTIVE_ATTR = "data-dsh-lumen";
/** Class on the injected stylesheet node. */
const STYLE_ID = "dsh-lumen-style";
/** Longest gap between wake-up checks, ms. Bounds the damage of a missed timer. */
const WAKE_CHECK_MS = 60000;
/** Overscale applied to blurred layers so the blur cannot eat the viewport edge. */
const BLUR_OVERSCALE = 1.06;
/** Extra blur on the `blur` fit's bleed layer, px. */
const BLEED_BLUR = 48;
/** WCAG AA body-text contrast the readability floor targets. */
const CONTRAST_TARGET = 4.5;

/**
 * A neutral film-grain tile. Generated rather than shipped: an SVG turbulence
 * filter is a few hundred bytes of text and produces better grain than a PNG
 * at any size, with no asset to licence.
 */
const NOISE_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>"
	+ "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/></filter>"
	+ "<rect width='180' height='180' filter='url(#n)'/></svg>";
const NOISE_URI = `url("data:image/svg+xml,${encodeURIComponent(NOISE_SVG)}")`;

/** The stylesheet the engine owns. Kept small and fully namespaced. */
const ENGINE_CSS = `
[${ACTIVE_ATTR}="root"]{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;contain:strict;}
[${ACTIVE_ATTR}="bleed"],[${ACTIVE_ATTR}="slot-0"],[${ACTIVE_ATTR}="slot-1"]{position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-size:cover;transition-property:opacity;transition-timing-function:cubic-bezier(0.4,0,0.2,1);}
[${ACTIVE_ATTR}="slot-0"],[${ACTIVE_ATTR}="slot-1"]{will-change:opacity;}
[${ACTIVE_ATTR}="grain"]{position:absolute;inset:0;background-image:${NOISE_URI};background-repeat:repeat;mix-blend-mode:overlay;opacity:0;transition:opacity 240ms ease;}
@media (prefers-reduced-motion: reduce){[${ACTIVE_ATTR}="slot-0"],[${ACTIVE_ATTR}="slot-1"]{transition-duration:0ms !important;}}
`;

/** Resolve an item into the CSS the backdrop layer needs. */
function itemToBackground(item, tuning) {
	if (!item) return null;
	if (item.kind === "recipe") {
		const rendered = renderRecipe({ recipeId: item.ref, seed: item.seed, tuning });
		return {
			image: rendered.backgroundImage,
			color: rendered.backgroundColor,
			complexity: rendered.complexity,
			luminance: estimateImageLuminance(rendered.backgroundImage, parseColor(rendered.backgroundColor))
		};
	}
	if (item.kind === "gradient") {
		return {
			image: item.ref,
			color: "rgba(0, 0, 0, 0)",
			complexity: 0.35,
			luminance: estimateImageLuminance(item.ref, null)
		};
	}
	// `image` (a data URL) and `url` (a remote address) both end up here. The
	// validation in state.cjs already rejected quotes, parens, backslashes and
	// whitespace, so the value cannot escape the url("…") wrapper.
	const source = item.kind === "image" ? item.ref : item.ref;
	return {
		image: `url("${source}")`,
		color: "rgba(0, 0, 0, 0)",
		complexity: 0.5,
		// A local picture was measured when it was imported (`image.sampleLuminance`)
		// and that number rides on the item from then on, so the readability floor
		// is solved against the real photograph rather than a constant.
		//
		// A *remote* picture still has to fall back: nothing has decoded it, and
		// the render path is synchronous, so there is no pixel to look at. Drawing
		// it to a canvas could not help either — a cross-origin source taints the
		// canvas and `getImageData` throws. So a URL keeps the neutral assumption,
		// which is deliberately bright because the two error directions are not
		// symmetric: over-estimating costs a slightly heavier wash, while
		// under-estimating is how a custom photo ends up with unreadable text.
		luminance: measuredLuminance(item)
	};
}

/**
 * The brightness a picture was measured at, or the neutral fallback.
 *
 * `null` and `undefined` both mean "never measured" and both fall back — the
 * item schema carries `luminance: null` explicitly, and a state written by an
 * older build has no field at all.
 */
function measuredLuminance(item) {
	const value = item === null || item === undefined ? undefined : item.luminance;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
	return NEUTRAL_LUMINANCE;
}

/**
 * Read the *raw* (un-washed) active theme.
 *
 * Reading `snapshot.active.tokens` directly would feed this plugin's own
 * previous wash back into the next computation and the canvas would darken a
 * little on every repaint. The registered definition selected by `preference`
 * is the un-composed one, so it is preferred; `active.id` is the fallback for
 * `preference === "system"`, where it resolves to the concrete light/dark entry.
 */
function readRawTheme(ctx) {
	let snapshot = null;
	try {
		snapshot = ctx.theme && typeof ctx.theme.getTheme === "function" ? ctx.theme.getTheme() : null;
	} catch {
		snapshot = null;
	}
	if (!snapshot || typeof snapshot !== "object") return null;
	const themes = Array.isArray(snapshot.themes) ? snapshot.themes : [];
	const activeId = snapshot.active && snapshot.active.id;
	const selectedId = snapshot.preference === "system" || !snapshot.preference ? activeId : snapshot.preference;
	const chosen = themes.find((t) => t && t.id === selectedId) || themes.find((t) => t && t.id === activeId) || snapshot.active;
	if (!chosen || !chosen.tokens || typeof chosen.tokens !== "object") return null;
	const scheme = chosen.colorScheme === "light" ? "light" : "dark";
	return {
		scheme,
		id: chosen.id,
		base: parseColor(chosen.tokens["--dsw-alias-bg-base"]),
		label: parseColor(chosen.tokens["--dsw-alias-label-primary"]),
		sidebar: parseColor(chosen.tokens["--dsw-specific-sidebar-fill"])
	};
}

/**
 * Build the engine.
 *
 * @param {object} options
 * @param {object} options.ctx cordis client context (theme service is used)
 * @param {object} options.store the persistence layer
 * @param {Document} [options.document]
 * @param {Window} [options.window]
 */
function createEngine(options) {
	const opts = options || {};
	const ctx = opts.ctx || {};
	const store = opts.store;
	const doc = opts.document || (typeof document !== "undefined" ? document : null);
	const win = opts.window || (typeof window !== "undefined" ? window : null);

	let root = null;
	let bleed = null;
	const slots = [null, null];
	let grain = null;
	let styleEl = null;
	/** Which slot currently holds the visible picture. */
	let front = 0;
	/** Identity of the picture on screen (`kind|ref|seed`) — a change cross-fades. */
	let lastIdentity = null;
	/** Identity plus every parameter that alters the painted result — a change repaints. */
	let lastRenderKey = null;
	let activeItem = null;
	/** Disposer for the current token-override layer. */
	let overrideDispose = null;
	/** Re-entrancy guard: `overrideTokens` emits `theme/change`, which we listen to. */
	let applyingOverride = false;
	let applying = false;
	let timer = null;
	let onThemeChange = null;
	let onVisibility = null;
	let disposed = false;
	let reducedMotion = false;
	let lastPlan = { due: false, missed: 0, nextAt: 0 };
	let lastRequiredAlpha = 0;

	/** Whether the DOM is usable at all (headless sandbox / teardown). */
	const domReady = () => doc !== null && doc.body !== null && doc.body !== undefined;

	function ensureStyle() {
		if (styleEl !== null && doc.contains(styleEl)) return;
		styleEl = doc.createElement("style");
		styleEl.id = STYLE_ID;
		styleEl.textContent = ENGINE_CSS;
		(doc.head || doc.documentElement).appendChild(styleEl);
	}

	function ensureDom() {
		if (!domReady()) return false;
		ensureStyle();
		if (root !== null && doc.body.contains(root)) return true;
		root = doc.createElement("div");
		root.setAttribute(ACTIVE_ATTR, "root");
		bleed = doc.createElement("div");
		bleed.setAttribute(ACTIVE_ATTR, "bleed");
		bleed.style.opacity = "0";
		root.appendChild(bleed);
		slots[0] = doc.createElement("div");
		slots[0].setAttribute(ACTIVE_ATTR, "slot-0");
		slots[1] = doc.createElement("div");
		slots[1].setAttribute(ACTIVE_ATTR, "slot-1");
		// slot-1 starts behind slot-0 in paint order, and `front` starts at 0, so
		// the first picture lands on a slot that is already on top: no fade-in
		// from a blank root on the very first paint.
		slots[0].style.opacity = "0";
		slots[1].style.opacity = "0";
		root.appendChild(slots[0]);
		root.appendChild(slots[1]);
		grain = doc.createElement("div");
		grain.setAttribute(ACTIVE_ATTR, "grain");
		root.appendChild(grain);
		// Prepended, not appended: it must be the first painted child so that
		// `z-index: -1` puts it behind everything the shell draws.
		doc.body.insertBefore(root, doc.body.firstChild);
		return true;
	}

	/** Apply the `blur` fit's backdrop, and only then. */
	function applyFit(item, blurPx, image, color) {
		const wash = store.getState().wash;
		const fit = wash.fit;
		const wantsBleed = fit === "blur";
		const size = fit === "cover" ? "cover" : "contain";
		for (const slot of slots) {
			if (slot === null) continue;
			slot.style.backgroundSize = size;
			// Where the subject sits. Only meaningful for a picture whose fitted
			// size is not the viewport's own — a recipe or a gradient at `cover`
			// fills the element, so the position moves nothing — but writing it
			// unconditionally keeps one code path instead of a branch that would
			// need its own tests.
			slot.style.backgroundPosition = wash.position;
		}
		if (bleed === null) return;
		if (wantsBleed) {
			bleed.style.backgroundImage = image;
			bleed.style.backgroundColor = color;
			bleed.style.backgroundSize = "cover";
			// The bleed layer stays centred: it exists to hide the mask edge of the
			// `contain` layer above it, and an off-centre blurred backdrop would
			// leave exactly the edge it was added to cover.
			bleed.style.backgroundPosition = "center";
			bleed.style.filter = `blur(${blurPx + BLEED_BLUR}px)`;
			bleed.style.transform = "scale(1.2)";
			bleed.style.opacity = "1";
		} else {
			bleed.style.opacity = "0";
			bleed.style.backgroundImage = "none";
		}
	}

	/** Push the wash tokens for the given effective alpha. */
	function applyWash(alpha, raw) {
		if (raw === null || raw.base === null || typeof ctx.theme?.overrideTokens !== "function") return;
		applyingOverride = true;
		try {
			// Only the active scheme's colour is known, so it is used for both
			// slots of the required {light, dark} pair. A scheme switch re-applies
			// this whole function, so the pair is never stale in a way the user can
			// see.
			const washed = withAlpha(raw.base, alpha);
			const sidebarBase = raw.sidebar !== null ? raw.sidebar : raw.base;
			const sidebarWashed = withAlpha(sidebarBase, alpha);
			const overrides = {
				"--dsw-alias-bg-base": { light: washed, dark: washed },
				"--dsw-specific-sidebar-fill": { light: sidebarWashed, dark: sidebarWashed }
			};
			const previous = overrideDispose;
			overrideDispose = ctx.theme.overrideTokens("dsh-lumen:wash", overrides);
			if (typeof previous === "function") previous();
		} catch (error) {
			try {
				console.warn("[dsh-lumen] could not publish the wash layer:", error && error.message);
			} catch {}
		} finally {
			applyingOverride = false;
		}
	}

	/** Drop the wash layer. */
	function clearWash() {
		if (typeof overrideDispose === "function") {
			try {
				overrideDispose();
			} catch {}
		}
		overrideDispose = null;
	}

	/**
	 * How opaque the wash must be for this picture.
	 * Returns the user's value and the solved minimum separately, so the panel
	 * can surface the difference instead of hiding it.
	 */
	function resolveAlpha(raw, background) {
		const wash = store.getState().wash;
		let required = 0;
		if (wash.readability && raw !== null && raw.label !== null && raw.base !== null && background !== null) {
			required = alphaForContrast(raw.base, raw.label, background.luminance, CONTRAST_TARGET, 1);
		}
		let effective = wash.opacity;
		if (wash.autoDim === true && background !== null) {
			// A busy or bright picture gets a heavier wash automatically. The lift
			// comes from this recipe's own declared complexity rather than a flat
			// rule, so how much help the text gets tracks how much this particular
			// wallpaper actually fights it.
			const lift = background.complexity * 0.12;
			effective = Math.min(0.98, effective + lift);
		}
		effective = Math.max(effective, required);
		lastRequiredAlpha = required;
		return { effective, required, chosen: wash.opacity };
	}

	/**
	 * Render a state.
	 *
	 * TWO DIFFERENT KINDS OF CHANGE, DELIBERATELY SEPARATED.
	 *
	 * A new *picture* deserves a cross-fade. Dragging the hue slider does not —
	 * the picture is the same one being re-coloured, and cross-fading on every
	 * pixel of a drag turns a slider into a strobe. So the identity of the item
	 * decides whether to animate, and the full parameter set only decides
	 * whether to do any work at all.
	 *
	 * @param {object} state
	 * @param {boolean} [instant] skip the transition (boot, theme change, teardown-ish)
	 */
	function render(state, instant) {
		if (disposed) return;
		if (applying) return;
		applying = true;
		try {
			const item = currentItem(state);
			activeItem = item;
			const background = itemToBackground(item, state.tuning);
			if (background === null) {
				teardownVisuals();
				return;
			}
			// Last gate before the DOM. The value is built by this plugin, but a
			// wallpaper string ends up in a CSS declaration, so it is checked by
			// shape rather than trusted by origin.
			if (!isSafeBackgroundImage(background.image)) {
				try {
					console.warn("[dsh-lumen] refused an unsafe background-image value");
				} catch {}
				return;
			}
			const raw = readRawTheme(ctx);
			const wash = state.wash;
			const identity = `${item.kind}|${item.ref}|${item.seed}`;
			// `position` belongs in the key even though it repaints nothing: without
			// it the short-circuit below would decide there is no work to do and a
			// position change would silently not appear until something else moved.
			const renderKey = `${identity}|${JSON.stringify(state.tuning)}|${wash.fit}|${wash.blur}|${wash.position}`;
			const needsWork = renderKey !== lastRenderKey;
			const needsCrossfade = identity !== lastIdentity;
			lastRenderKey = renderKey;
			lastIdentity = identity;

			if (!ensureDom()) {
				// Headless: the token layer is still published so a DOM-less
				// environment (or a teardown race) leaves the theme consistent,
				// but nothing pretends a picture was painted.
				applyWash(state.wash.opacity, raw);
				return;
			}
			if (!needsWork && !needsCrossfade) {
				applyWash(resolveAlpha(raw, background).effective, raw);
				return;
			}

			const blurPx = wash.blur;
			applyFit(item, blurPx, background.image, background.color);
			const transition = instant === true || reducedMotion ? 0 : normalizeSchedule(state.schedule).transitionMs;

			// The slot to paint into: the hidden one on a cross-fade, the visible
			// one when only parameters moved.
			const target = needsCrossfade ? slots[1 - front] : slots[front];
			const outgoing = needsCrossfade ? slots[front] : null;
			for (const slot of [target, outgoing]) {
				if (slot === null || slot === undefined) continue;
				slot.style.backgroundImage = background.image;
				slot.style.backgroundColor = background.color;
				slot.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
				slot.style.transform = blurPx > 0 ? `scale(${BLUR_OVERSCALE})` : "none";
				slot.style.transitionDuration = `${transition}ms`;
			}
			if (needsCrossfade && target !== null && target !== undefined) {
				target.style.opacity = "0";
				// Force a style flush so the 0 -> 1 transition actually plays; without
				// it the browser coalesces both writes and the picture pops in.
				if (typeof target.getBoundingClientRect === "function") void target.getBoundingClientRect();
				target.style.opacity = "1";
				if (outgoing !== null && outgoing !== undefined) outgoing.style.opacity = "0";
				front = 1 - front;
			}
			if (grain !== null) {
				// A raster picture already has its own texture; adding the full grain
				// on top reads as noise, so custom pictures get half of it.
				const strength = item.kind === "recipe" ? state.tuning.grain : state.tuning.grain * 0.5;
				grain.style.opacity = String(Math.round(strength * 55) / 100);
			}
			applyWash(resolveAlpha(raw, background).effective, raw);
			if (doc.documentElement && typeof doc.documentElement.setAttribute === "function") {
				doc.documentElement.setAttribute("data-dsh-lumen-active", "1");
			}
		} catch (error) {
			try {
				console.warn("[dsh-lumen] render failed:", error && error.message);
			} catch {}
		} finally {
			applying = false;
		}
	}

	/** Remove every visual the engine installed. */
	function teardownVisuals() {
		lastIdentity = null;
		lastRenderKey = null;
		activeItem = null;
		clearWash();
		if (doc === null) return;
		if (doc.documentElement && typeof doc.documentElement.removeAttribute === "function") {
			doc.documentElement.removeAttribute("data-dsh-lumen-active");
		}
		if (root !== null && typeof root.remove === "function") root.remove();
		if (styleEl !== null && typeof styleEl.remove === "function") styleEl.remove();
		root = null;
		bleed = null;
		slots[0] = null;
		slots[1] = null;
		grain = null;
		styleEl = null;
	}

	/** Schedule the next wake-up. */
	function armTimer(state) {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (disposed || state.mode !== "rotation" || state.paused === true) return;
		const schedule = normalizeSchedule(state.schedule);
		if (schedule.mode === "session") return;
		const nextAt = state.nextAt > 0 ? state.nextAt : upcomingTriggers(schedule, Date.now(), 1)[0] || 0;
		if (nextAt <= 0) return;
		const delay = Math.max(250, Math.min(nextAt - Date.now(), WAKE_CHECK_MS));
		timer = setTimeout(() => {
			timer = null;
			tick();
		}, delay);
	}

	/**
	 * One wake-up: advance if due, then re-arm.
	 * Also the catch-up path — a machine that was asleep past several triggers
	 * lands here once and moves on by exactly one step (see scheduler.planResume).
	 */
	function tick() {
		if (disposed) return;
		const state = store.getState();
		const schedule = normalizeSchedule(state.schedule);
		if (schedule.mode === "session") return;
		const plan = planResume(schedule, Date.now(), state.nextAt);
		lastPlan = plan;
		if (plan.due) {
			rotate("timer");
			return;
		}
		if (plan.nextAt !== state.nextAt) {
			store.update((draft) => {
				draft.nextAt = plan.nextAt;
				return draft;
			});
			store.save();
		}
		armTimer(store.getState());
	}

	/**
	 * Move to the next playlist entry.
	 * @param {string} reason "timer" | "manual" | "session"
	 */
	function rotate(reason) {
		const state = store.getState();
		if (state.playlist.length === 0) return;
		if (reason === "timer" && state.paused === true) return;
		store.update((draft) => {
			const next = stepCursor({
				cursor: draft.cursor,
				length: draft.playlist.length,
				order: draft.schedule.order,
				remaining: draft.remaining,
				orderStep: draft.orderStep
			});
			draft.cursor = next.cursor;
			draft.remaining = next.remaining;
			draft.orderStep = next.orderStep;
			const schedule = normalizeSchedule(draft.schedule);
			const upcoming = upcomingTriggers(schedule, Date.now(), 1);
			draft.nextAt = upcoming.length > 0 ? upcoming[0] : 0;
			return draft;
		});
		store.save();
		render(store.getState(), false);
		armTimer(store.getState());
	}

	/** Jump to a specific playlist index. */
	function goTo(index, instant) {
		store.update((draft) => {
			if (draft.playlist.length === 0) return draft;
			draft.cursor = Math.max(0, Math.min(draft.playlist.length - 1, Math.floor(index)));
			draft.remaining = [];
			const upcoming = upcomingTriggers(normalizeSchedule(draft.schedule), Date.now(), 1);
			draft.nextAt = upcoming.length > 0 ? upcoming[0] : 0;
			return draft;
		});
		store.save();
		render(store.getState(), instant === true);
		armTimer(store.getState());
	}

	/** Re-solve the schedule after the config changed (mode, interval, order…). */
	function reschedule() {
		store.update((draft) => {
			const schedule = normalizeSchedule(draft.schedule);
			const upcoming = upcomingTriggers(schedule, Date.now(), 1);
			draft.nextAt = upcoming.length > 0 ? upcoming[0] : 0;
			draft.remaining = [];
			draft.orderRevision = (draft.orderRevision || 1) + 1;
			return draft;
		});
		store.save();
		armTimer(store.getState());
	}

	/** Attach theme + visibility listeners; called from `start`. */
	function attachListeners() {
		if (ctx !== null && typeof ctx.on === "function") {
			onThemeChange = () => {
				if (applyingOverride) return;
				// The theme swapped underneath us: repaint from the raw theme with no
				// transition, so a light/dark switch does not cross-fade the
				// wallpaper against itself.
				lastIdentity = null;
				lastRenderKey = null;
				render(store.getState(), true);
			};
			ctx.on("theme/change", onThemeChange);
		}
		if (doc !== null && typeof doc.addEventListener === "function") {
			onVisibility = () => {
				if (doc.visibilityState !== "visible") return;
				const state = store.getState();
				const schedule = normalizeSchedule(state.schedule);
				if (schedule.mode === "session" && state.mode === "rotation" && state.paused !== true) {
					rotate("session");
					return;
				}
				// A wake-up also has to re-check the clock: the timer may have fired
				// while the tab was frozen, or the machine may have slept through it.
				tick();
			};
			doc.addEventListener("visibilitychange", onVisibility);
		}
		if (win !== null && typeof win.matchMedia === "function") {
			try {
				const mq = win.matchMedia("(prefers-reduced-motion: reduce)");
				reducedMotion = mq.matches === true;
				if (typeof mq.addEventListener === "function") {
					mq.addEventListener("change", (event) => {
						reducedMotion = event.matches === true;
					});
				}
			} catch {
				reducedMotion = false;
			}
		}
	}

	/** Start: attach listeners, run the resume plan, paint. */
	function start() {
		attachListeners();
		const state = store.getState();
		if (state.mode === "rotation" && state.paused !== true) {
			const plan = planResume(normalizeSchedule(state.schedule), Date.now(), state.nextAt);
			lastPlan = plan;
			if (plan.due) {
				rotate("timer");
				return;
			}
			if (plan.nextAt !== state.nextAt) {
				store.update((draft) => {
					draft.nextAt = plan.nextAt;
					return draft;
				});
				store.save();
			}
		}
		render(store.getState(), true);
		armTimer(store.getState());
	}

	/** Stop and remove everything. */
	function dispose() {
		disposed = true;
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (onVisibility !== null && typeof doc?.removeEventListener === "function") {
			doc.removeEventListener("visibilitychange", onVisibility);
		}
		onVisibility = null;
		onThemeChange = null;
		teardownVisuals();
	}

	return {
		start,
		dispose,
		render: (instant) => render(store.getState(), instant === true),
		rotate,
		goTo,
		reschedule,
		tick,
		/** Introspection for the panel and the diagnostics global. */
		inspect: () => ({
			activeItem,
			requiredAlpha: lastRequiredAlpha,
			plan: lastPlan,
			reducedMotion,
			hasDom: root !== null,
			active: root !== null
		})
	};
}

module.exports = { createEngine, itemToBackground, readRawTheme, ACTIVE_ATTR, STYLE_ID, NOISE_URI, CONTRAST_TARGET };
