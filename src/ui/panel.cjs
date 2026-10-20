"use strict";
/**
 * The settings panel.
 *
 * Framework-free on purpose (see `dom.cjs`): the same builder renders inside
 * DSH's React settings section and inside the standalone preview page, so what
 * the preview demonstrates is the panel that ships, not a mock-up of it.
 *
 * THE INTERACTION MODEL. The panel is built once and then synced: every control
 * keeps a handle and `sync()` pushes current state into it. Rebuilding the DOM
 * on each change would be simpler to write and would break every slider
 * mid-drag (the node under the pointer would be replaced), so only the genuinely
 * list-shaped parts — the recipe chips, the playlist, the upcoming triggers —
 * are re-rendered, and only when their contents changed.
 *
 * Repaints are coalesced through `requestAnimationFrame`. A wash slider emits an
 * input event per pixel; without coalescing that is a recipe re-render (and a
 * few thousand characters of CSS string) sixty times a second.
 */

const dom = require("./dom.cjs");
const { ensurePanelStyle } = require("./styles.cjs");
const { RECIPES, renderRecipe } = require("../wallpapers.cjs");
const { itemToBackground } = require("../engine.cjs");
const {
	currentItem,
	createItem,
	createItemId,
	DEFAULT_STATE,
	MAX_PLAYLIST,
	OPACITY_MIN,
	OPACITY_MAX,
	VISIBILITY_MIN,
	VISIBILITY_MAX,
	BLUR_MIN,
	BLUR_MAX,
	WASH_POSITIONS
} = require("../state.cjs");
const {
	INTERVAL_MIN,
	INTERVAL_MAX,
	TRANSITION_MIN,
	TRANSITION_MAX,
	upcomingTriggers,
	normalizeSchedule,
	normalizeHourlyMinutes
} = require("../scheduler.cjs");
const { prepareImage } = require("../image.cjs");
// The splash's media route, taken from the module that owns it rather than
// typed out again: the preview is a plain <img>-style fetch of whatever the
// host is serving, so it has to be the same path the host half answers on.
const { MEDIA_PATH } = require("../splash.cjs");
const { createTranslator } = require("../i18n.cjs");

/** Preset minutes-past-the-hour offered by the hourly trigger. */
const HOUR_PRESETS = [0, 15, 30, 45];
/** How often the countdown readout refreshes, ms. */
const TICK_MS = 1000;
/** How long a confirmation toast stays up, ms. */
const TOAST_MS = 1900;

/**
 * The nine cells of the position grid, in reading order.
 *
 * Listed here rather than derived from `WASH_POSITIONS` because the state
 * constant is a set — correct for validating an incoming value, useless for
 * laying out a 3x3. A test pins the two together so a position added to the
 * state cannot quietly become unreachable in the UI.
 */
const POSITION_CELLS = [
	{ value: "top left", key: "position.tl" },
	{ value: "top", key: "position.top" },
	{ value: "top right", key: "position.tr" },
	{ value: "left", key: "position.left" },
	{ value: "center", key: "position.center" },
	{ value: "right", key: "position.right" },
	{ value: "bottom left", key: "position.bl" },
	{ value: "bottom", key: "position.bottom" },
	{ value: "bottom right", key: "position.br" }
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pad2 = (v) => String(v).padStart(2, "0");

/**
 * `90` -> "1 分 30 秒" (or "1m 30s"). The units live in the dictionary: a
 * formatter that hardcodes them reads correctly in the language it was written
 * in and produces "1 分 30 秒" in every other one.
 */
function formatDuration(ms, translate) {
	const t = typeof translate === "function" ? translate : createTranslator("zh");
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return t("duration.seconds", { n: total });
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return t("duration.minutes", { m: minutes, s: pad2(total % 60) });
	return t("duration.hours", { h: Math.floor(minutes / 60), m: pad2(minutes % 60) });
}

/** `13:05` for a timestamp today; `明天 07:30` for one that has rolled over. */
function formatClockStamp(ts, now) {
	const d = new Date(ts);
	const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const a = new Date(now);
	const sameDay = d.getFullYear() === a.getFullYear() && d.getMonth() === a.getMonth() && d.getDate() === a.getDate();
	return sameDay ? clock : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${clock}`;
}

/** The built-in entry behind a `recipe`-kind item, or `undefined`. */
function builtinOf(item) {
	if (!item || item.kind !== "recipe") return undefined;
	return RECIPES.find((r) => r.id === item.ref);
}

/** True when the item is one of the bundled illustrations rather than a recipe. */
function isPhotoItem(item) {
	const recipe = builtinOf(item);
	return recipe !== undefined && typeof recipe.photo === "string";
}

/** The display name of a playlist entry. */
function itemLabel(item, lang, translate) {
	if (!item) return "";
	// Every string a user can read comes from the dictionary; `lang` only ever
	// selects between two pieces of *data* (a recipe's own name fields), never
	// between two hardcoded sentences. A bilingual ternary here would look fine
	// in both languages the author speaks and be unreachable to the translation
	// test.
	const t = typeof translate === "function" ? translate : createTranslator(lang);
	if (item.kind === "recipe") {
		const recipe = builtinOf(item);
		const name = recipe === undefined ? item.ref : lang === "en" ? recipe.name.en : recipe.name.zh;
		// A seed is a variation selector for a generated recipe. An illustration
		// has no variations, so printing one next to its name would advertise a
		// knob that turns nothing.
		if (isPhotoItem(item)) return name;
		return item.seed === "default" ? name : `${name} · ${item.seed}`;
	}
	if (item.kind === "image") return `${t("kind.image")} (${Math.round(item.ref.length / 1024)}KB)`;
	if (item.kind === "url") {
		try {
			return new URL(item.ref).hostname;
		} catch {
			return t("kind.url");
		}
	}
	return t("kind.gradient");
}

/** The preview swatch for an entry, or a neutral placeholder. */
function itemSwatch(item, tuning) {
	const background = itemToBackground(item, tuning);
	if (background === null) return dom.swatch("none", "rgba(128,128,128,.3)");
	return dom.swatch(background.image, background.color);
}

/**
 * The real byte size behind a `data:` URL.
 *
 * Base64 spends four characters on every three bytes, so the string length is
 * not the file size — reporting it raw overstates the picture by a third, and
 * the number sits next to a knob the user can use to judge whether it is worth
 * keeping. Three quarters of the payload, minus the `data:...;base64,` header.
 */
function dataUrlKb(ref) {
	const comma = typeof ref === "string" ? ref.indexOf(",") : -1;
	const payload = comma >= 0 ? ref.length - comma - 1 : 0;
	return Math.max(1, Math.round((payload * 3) / 4 / 1024));
}

/**
 * Build the settings panel.
 *
 * @param {object} deps
 * @param {object} deps.store persistence layer
 * @param {object} deps.engine render engine
 * @param {(key: string, params?: object) => string} deps.t translator
 * @param {string} [deps.lang] "zh" | "en"
 * @param {object} [deps.window]
 * @param {object} [deps.document]
 */
function createPanel(deps) {
	const store = deps.store;
	const engine = deps.engine;
	const t = typeof deps.t === "function" ? deps.t : (key) => key;
	const lang = deps.lang === "en" ? "en" : "zh";
	const win = deps.window || (typeof window !== "undefined" ? window : null);
	const doc = deps.document || (typeof document !== "undefined" ? document : null);
	/**
	 * The splash's browser half, when the host offers one.
	 *
	 * Optional on purpose: the panel is also built by tests and by hosts that
	 * never mount `splash.cjs`, and a settings section that cannot render without
	 * a second module would make the wallpaper's own features hostage to it.
	 */
	const splash = deps.splash || null;
	ensurePanelStyle(doc);

	let destroyed = false;
	let rafPending = false;
	let ticker = null;
	/** The confirmation toast's node and dismissal timer (created on first use). */
	let toastNode = null;
	let toastTimer = null;
	/** Transient user-facing message (an image that would not process, a copy result). */
	const banner = { text: null, warn: false };
	/** Editor drafts, kept out of persisted state until the user commits them. */
	const gradientDraft = { from: "#141a2e", to: "#4a3a86", angle: 160 };
	const urlDraft = { value: "" };

	// ── shared plumbing ───────────────────────────────────────────────────────

	/** Coalesce repaints to one per frame. */
	function requestRender(instant) {
		if (rafPending || destroyed) return;
		rafPending = true;
		const run = () => {
			rafPending = false;
			if (destroyed) return;
			engine.render(instant === true);
		};
		if (win !== null && typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
		else setTimeout(run, 16);
	}

	/** Report something to the user, in the panel, without an alert(). */
	function say(text, warn) {
		banner.text = text;
		banner.warn = warn === true;
		sync();
	}

	/**
	 * Confirm a wallpaper change with a short-lived toast.
	 *
	 * The banner is the panel's error channel and it sits inside the section;
	 * the point of this one is different — the user just clicked a picture and
	 * is looking at the *page*, not at the panel. So it is anchored to the
	 * viewport, it is never an error, and it says only one thing: what is now on
	 * screen. Successes are deliberately not routed through `say()`: a rotating
	 * wallpaper announcing itself in the error line would make every good
	 * outcome look like a warning.
	 */
	function toast(text) {
		if (text === null || text === undefined || text === "" || destroyed) return;
		if (doc === null || doc.body === null || doc.body === undefined) return;
		if (toastNode === null) {
			toastNode = dom.h("div", {
				class: "lumen-toast",
				attrs: { role: "status", "aria-live": "polite" }
			});
		}
		toastNode.textContent = String(text);
		// Parented to the panel, not to `document.body`: the toast then inherits
		// the `--lumen-*` alias layer (so it follows a third-party theme) and is
		// torn down with the panel. It is `position:fixed`, so the panel's own
		// scrolling does not move it.
		if (toastNode.parentNode !== root) root.appendChild(toastNode);
		toastNode.classList.remove("is-on");
		// Reading layout between the two class writes is what restarts the
		// transition when the same message is confirmed twice in a row.
		if (typeof toastNode.getBoundingClientRect === "function") void toastNode.getBoundingClientRect();
		toastNode.classList.add("is-on");
		if (toastTimer !== null) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toastTimer = null;
			if (toastNode !== null) toastNode.classList.remove("is-on");
		}, TOAST_MS);
	}

	/** The sentence a successful change is confirmed with. */
	function confirmApplied() {
		const item = currentItem(store.getState());
		toast(t("toast.applied", { name: itemLabel(item, lang, t) }));
	}

	/**
	 * Replace a field on whichever entry is on screen.
	 * In rotation mode that is the *current playlist entry*, so clicking a recipe
	 * while rotating edits the slot you are looking at rather than silently
	 * creating a parallel "single" selection the user cannot see.
	 */
	function patchCurrent(patch) {
		store.update((draft) => {
			if (draft.mode === "rotation" && draft.playlist.length > 0) {
				const index = clamp(draft.cursor, 0, draft.playlist.length - 1);
				draft.playlist[index] = { ...draft.playlist[index], ...patch };
			} else {
				draft.single = { ...draft.single, ...patch };
			}
			return draft;
		});
		store.save();
		requestRender();
		sync();
		// Confirm after the state write, so the toast names the picture the
		// engine has just been told to paint rather than the one it replaces.
		confirmApplied();
	}

	/** Apply a wash change and repaint (tokens effectively change, not the picture). */
	function patchWash(patch) {
		store.update((draft) => {
			draft.wash = { ...draft.wash, ...patch };
			draft.washTouched = true;
			return draft;
		});
		store.save();
		requestRender();
		sync();
	}

	/** Apply a tuning change (regenerates the picture in place). */
	function patchTuning(patch) {
		store.update((draft) => {
			draft.tuning = { ...draft.tuning, ...patch };
			return draft;
		});
		store.save();
		requestRender();
	}

	/** Apply a schedule change and re-arm the timer. */
	function patchSchedule(patch) {
		store.update((draft) => {
			draft.schedule = { ...draft.schedule, ...patch };
			return draft;
		});
		engine.reschedule();
		sync();
	}

	// ── hero: what is on screen right now ─────────────────────────────────────

	const heroNode = dom.h("div", { class: "lumen-card" });
	const heroPreview = dom.h("div", { class: "lumen-hero-preview" });
	const heroName = dom.h("div", { class: "lumen-hero-name" });
	const heroSub = dom.h("div", { class: "lumen-hero-sub" });
	/** The "shake" control, kept so `sync` can hide it on an illustration. */
	let shakeButton = null;

	function shake() {
		const seed = `s${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
		patchCurrent({ seed });
	}

	function addCurrentToList() {
		const state = store.getState();
		if (state.playlist.length >= MAX_PLAYLIST) {
			say(t("rotation.full", { n: MAX_PLAYLIST }), true);
			return;
		}
		const item = currentItem(state);
		// `luminance` rides along: a duplicated picture that lost its measurement
		// would silently fall back to the constant and get a different wash than
		// the original it was copied from.
		const created = createItem(item.kind, item.ref, item.seed, item.luminance);
		if (created === null) {
			say(t("rotation.unstorable"), true);
			return;
		}
		store.update((draft) => {
			draft.playlist.push(created);
			return draft;
		});
		store.save();
		sync();
	}

	{
		// Two buttons, not three. "Copy seed" was the third and it earned its
		// removal: the seed is already printed in the hero's subtitle, it is
		// niche, and every extra control in the header pushes the actual
		// wallpapers further down the panel.
		const actions = dom.h("div", { class: "lumen-hero-actions" });
		// Hidden rather than disabled for an illustration: "shake" means "same
		// recipe, fresh parameters", and a picture has neither. A disabled button
		// would pose the question "why can't I?" on every photo.
		shakeButton = dom.button(t("hero.shake"), shake, { small: true, hint: t("hero.shake.hint") });
		actions.appendChild(shakeButton);
		actions.appendChild(dom.button(t("hero.add"), addCurrentToList, { small: true, variant: "ghost" }));
		const meta = dom.h("div", { class: "lumen-hero-meta" }, [heroName, heroSub, actions]);
		heroNode.appendChild(dom.h("div", { class: "lumen-hero" }, [heroPreview, meta]));
	}

	// ── built-in recipe picker ────────────────────────────────────────────────

	const recipeStrip = dom.chipStrip();
	const recipeChips = new Map();
	for (const recipe of RECIPES) {
		const label = dom.h("span", { class: "lumen-chip-label", text: lang === "en" ? recipe.name.en : recipe.name.zh });
		const art = dom.swatch("none", "rgba(128,128,128,.25)");
		const chip = dom.h("button", {
			class: "lumen-chip",
			attrs: { type: "button", "data-recipe": recipe.id, title: `${recipe.name.zh} / ${recipe.name.en}` },
			on: {
				click: () => patchCurrent({ kind: "recipe", ref: recipe.id })
			}
		});
		chip.appendChild(art);
		chip.appendChild(label);
		recipeChips.set(recipe.id, { chip, art });
		recipeStrip.el.appendChild(chip);
	}
	const builtinGroup = dom.h("div", { class: "lumen-card" }, recipeStrip.el);

	// ── custom wallpaper: file, URL, gradient ─────────────────────────────────

	const customGroup = dom.h("div", { class: "lumen-card" });
	/**
	 * What the custom sources currently have applied, shown as the picture.
	 *
	 * This row used to be a bare "96KB", which answers how big and nothing else.
	 * A 46x30 crop of the actual image answers the question a person actually
	 * has after closing the panel and coming back — "is this the one I picked" —
	 * and it is the only thing that can.
	 */
	const appliedThumb = dom.h("div", { class: "lumen-applied-thumb" });
	const appliedText = dom.h("span", { class: "lumen-applied-text" });
	const imageHint = dom.h("div", { class: "lumen-applied" }, [appliedThumb, appliedText]);
	imageHint.style.display = "none";

	/** Map an intake failure code onto the sentence the user reads. */
	function errorKeyFor(code) {
		return {
			"not-an-image": "error.notImage",
			"too-large": "error.tooLarge",
			"decode-failed": "error.decode",
			"still-too-large": "error.stillTooLarge",
			"no-canvas": "error.noCanvas"
		}[code] || "error.decode";
	}

	/** Only pictures are worth handing to the decoder. */
	function isImageFile(file) {
		return file !== null && file !== undefined && typeof file.type === "string" && file.type.indexOf("image/") === 0;
	}

	/**
	 * Install a batch of freshly imported pictures.
	 *
	 * ONE STATE WRITE FOR THE WHOLE BATCH. Applying each picture as it arrived
	 * would mean a save and a repaint per file — five photographs would repaint
	 * six times and write the durable file six times to reach the same end
	 * state. The loop that produces the pictures is the slow part; installing
	 * them is not, so it happens once.
	 *
	 * The FIRST picture becomes what is on screen, because that is the one the
	 * user will judge the import by; the rest go to the playlist, which is where
	 * a batch of candidates is useful (the rotation scheduler can then walk
	 * them). The playlist cap is reported rather than silently swallowing the
	 * overflow.
	 *
	 * @returns {number} how many pictures could not be kept
	 */
	function applyImported(results) {
		const first = createItem("image", results[0].dataUrl, "default", results[0].luminance);
		if (first === null) return results.length;
		let dropped = 0;
		store.update((draft) => {
			draft.single = first;
			for (const result of results.slice(1)) {
				if (draft.playlist.length >= MAX_PLAYLIST) {
					dropped += 1;
					continue;
				}
				const item = createItem("image", result.dataUrl, "default", result.luminance);
				if (item === null) dropped += 1;
				else draft.playlist.push(item);
			}
			return draft;
		});
		store.save();
		requestRender();
		sync();
		confirmApplied();
		return dropped;
	}

	let importing = false;

	/**
	 * Import picked or dropped files.
	 *
	 * SERIAL, NOT `Promise.all`. Each decode holds a full-resolution bitmap, so
	 * five 12MP photographs decoded together is a few hundred megabytes of live
	 * pixels and the tab dies on a laptop before it finishes. One at a time
	 * bounds the peak at a single picture, and on this workload the difference
	 * is not perceptible.
	 *
	 * A FAILURE DOES NOT ABORT THE BATCH. If the third of five files is a
	 * mislabelled text file, the user wants the other four — so failures are
	 * collected and reported alongside the successes, not thrown past them.
	 *
	 * @returns {Promise<boolean>} whether anything was actually installed. The
	 * caller that asks for a picture AND a splash in one gesture has to know
	 * whether the first half happened, and every failure path here speaks only
	 * through the banner — a return value is the only way to tell the two apart
	 * without reading the sentence back.
	 */
	async function importFiles(files) {
		const images = (Array.isArray(files) ? files : []).filter(isImageFile);
		if (images.length === 0) {
			say(t("error.notImage"), true);
			return false;
		}
		if (importing) return false;
		importing = true;
		const accepted = [];
		const failures = [];
		try {
			for (let i = 0; i < images.length; i += 1) {
				say(images.length > 1 ? t("custom.importing", { i: i + 1, n: images.length }) : t("custom.image.processing"), false);
				try {
					accepted.push(await prepareImage(images[i], {}));
				} catch (error) {
					failures.push(error && error.message ? error.message : "decode-failed");
				}
			}
		} finally {
			importing = false;
		}
		if (accepted.length === 0) {
			say(t(errorKeyFor(failures[0])), true);
			return false;
		}
		const dropped = applyImported(accepted);
		// Failures are surfaced even when something succeeded: a batch that
		// quietly lost two of five files is worse than one that says so.
		if (failures.length > 0) {
			say(t("custom.importPartial", { ok: accepted.length, failed: failures.length }), true);
			return true;
		}
		if (accepted.length === 1) {
			const one = accepted[0];
			say(t("custom.image.stored", { w: one.width, h: one.height, kb: Math.round(one.bytes / 1024) }), false);
			return true;
		}
		if (dropped > 0) {
			say(t("custom.importCapped", { n: accepted.length - dropped, cap: MAX_PLAYLIST }), false);
			return true;
		}
		say(t("custom.imported", { n: accepted.length }), false);
		return true;
	}

	const picker = dom.filePicker("image/*", importFiles);
	const urlInput = dom.h("input", {
		class: "lumen-inline-input is-wide",
		attrs: { type: "text", placeholder: t("custom.url.placeholder"), spellcheck: "false" }
	});
	urlInput.addEventListener("input", () => {
		urlDraft.value = urlInput.value;
	});
	const fromInput = dom.h("input", { class: "lumen-inline-input", attrs: { type: "color", value: gradientDraft.from, "aria-label": t("custom.from") } });
	const toInput = dom.h("input", { class: "lumen-inline-input", attrs: { type: "color", value: gradientDraft.to, "aria-label": t("custom.to") } });
	const angleSlider = dom.slider({
		min: 0,
		max: 360,
		step: 1,
		value: gradientDraft.angle,
		label: t("custom.angle"),
		format: (v) => `${v}°`,
		onInput: (v) => {
			gradientDraft.angle = v;
		}
	});
	fromInput.addEventListener("input", () => {
		gradientDraft.from = fromInput.value;
	});
	toInput.addEventListener("input", () => {
		gradientDraft.to = toInput.value;
	});
	function applyGradient() {
		const regex = /^#[0-9a-fA-F]{6}$/;
		if (!regex.test(gradientDraft.from) || !regex.test(gradientDraft.to)) {
			say(t("error.gradientInvalid"), true);
			return;
		}
		const css = `linear-gradient(${Math.round(gradientDraft.angle)}deg, ${gradientDraft.from} 0%, ${gradientDraft.to} 100%)`;
		patchCurrent({ kind: "gradient", ref: css, seed: "default" });
	}
	function applyUrl() {
		const value = urlDraft.value.trim();
		if (!/^https?:\/\//i.test(value)) {
			say(t("error.urlInvalid"), true);
			return;
		}
		patchCurrent({ kind: "url", ref: value, seed: "default" });
	}
	/**
	 * The three custom sources are one control, not three stacked rows.
	 *
	 * They used to be laid out in full — a picker, a URL box, two colour wells
	 * and an angle slider, each with its own button — which is a lot of panel
	 * for the one source a person is actually using. A segmented switch shows
	 * only the chosen source, so the card carries one button at a time instead
	 * of three and the panel is two thirds shorter.
	 */
	let customSource = "local";
	const customBody = dom.h("div", { class: "lumen-source-body" });
	const customSwitch = dom.segmented({
		value: "local",
		options: [
			{ value: "local", label: t("custom.local") },
			{ value: "url", label: t("custom.url") },
			{ value: "gradient", label: t("custom.gradient") }
		],
		onChange: (value) => {
			customSource = value;
			renderCustomSource();
		}
	});

	function renderCustomSource() {
		dom.clear(customBody);
		if (customSource === "local") {
			const localRow = dom.row(null, t("custom.local.hint"), [
				picker,
				dom.button(t("custom.choose"), () => picker.click(), { small: true })
			]);
			// Dropping onto the row (not just the button) is what makes "drag a
			// folder of candidates in" work — the row is the thing the user aims at.
			dom.acceptDrops(localRow, importFiles);
			customBody.appendChild(localRow);
		} else if (customSource === "url") {
			customBody.appendChild(dom.h("div", { class: "lumen-row is-stack" }, urlInput));
			customBody.appendChild(
				dom.row(null, t("custom.url.hint"), [dom.button(t("custom.apply"), applyUrl, { small: true })])
			);
		} else {
			customBody.appendChild(
				dom.row(null, t("custom.gradient.hint"), [
					fromInput,
					toInput,
					dom.button(t("custom.apply"), applyGradient, { small: true })
				])
			);
			customBody.appendChild(dom.h("div", { class: "lumen-row is-stack" }, angleSlider.el));
		}
	}

	customGroup.appendChild(dom.row(t("custom.source"), null, customSwitch.el));
	customGroup.appendChild(customBody);
	customGroup.appendChild(imageHint);
	renderCustomSource();

	// ── splash: one file, and a destination the user picks afterwards ─────────
	//
	// The flow is deliberately two steps, because the question has two answers
	// and only one file. Picking the destination first would mean the same
	// picture has to be picked twice to be used twice; staging the file and then
	// asking where it goes makes "both" a single click, which is the common case.
	//
	// The staging is *not* state. It is a file the user is holding, and writing
	// it into the durable document would leave a half-made decision on disk after
	// a reload — where nothing could finish it and nothing could clean it up.

	/** The file the user picked and has not yet said what to do with. */
	let staged = null;
	/** What the last probe found, or null when the host could not be asked. */
	let splashInfo = null;
	/** Identity of the staged file the targets row was built for. */
	let targetsKey = null;

	/** Map an upload or clear failure onto the sentence the user reads. */
	function splashErrorKey(reason) {
		return {
			"no-host": "splash.error.noHost",
			"unsupported-type": "splash.error.unsupported",
			"payload-too-large": "splash.error.tooLarge",
			"network": "splash.error.network"
		}[reason] || "splash.error.failed";
	}

	/** Re-read what the host is serving, so the status line is the host's answer. */
	function refreshSplashInfo() {
		if (splash === null) return;
		splash.probe().then((result) => {
			if (destroyed) return;
			splashInfo = result;
			sync();
		}).catch(() => {});
	}

	/**
	 * Take one file off a picker or a drop and hold it.
	 *
	 * Only the first is kept even if more arrived: the host's route takes one
	 * entity and stores one name, so accepting a batch here would be offering
	 * something the other end cannot honour.
	 */
	function stageFiles(files) {
		const list = Array.isArray(files) ? files : [];
		if (list.length === 0) return;
		const file = list[0];
		if (splash.classify(file.type) === null) {
			say(t("splash.error.unsupported"), true);
			return;
		}
		staged = { file, kind: splash.classify(file.type) };
		say(list.length > 1 ? t("splash.oneAtATime") : null, list.length > 1);
		sync();
	}

	/** Do the thing the user just asked for with the file they are holding. */
	async function applyStaged(target) {
		if (staged === null) return;
		const file = staged.file;
		const kind = staged.kind;
		const wantsWallpaper = target === "wallpaper" || target === "both";
		const wantsSplash = target === "splash" || target === "both";
		const kb = Math.max(1, Math.round((Number(file.size) || 0) / 1024));
		let wallpapered = false;
		let wallpaperedTried = false;
		let splashed = false;

		if (wantsWallpaper && kind === "image") {
			// The plugin's own intake, unchanged: same decode, same size ceiling,
			// same "first one on screen, the rest into the playlist" rule. A splash
			// that imported pictures its own way would be a second intake to keep
			// honest.
			wallpaperedTried = true;
			wallpapered = (await importFiles([file])) === true;
		}
		if (wantsSplash) {
			say(t("splash.uploading"), false);
			const result = await splash.upload(file);
			if (result.ok === true) {
				splashed = true;
				// Bumped before `sync()` sees the new answer, so the preview re-reads
				// the route instead of painting the cached file it just replaced.
				thumbVersion += 1;
				splashInfo = { configured: true, kind: result.kind, bytes: result.bytes };
			} else {
				say(t(splashErrorKey(result.reason)), true);
			}
		}

		if (splashed) {
			staged = null;
			const wallpaperFailed = wallpaperedTried && !wallpapered;
			if (wallpaperFailed) {
				// The status line under these buttons is the durable answer and it
				// has already moved to the new splash; the banner is for what went
				// wrong. Saying "set as both" here would be the panel taking credit
				// for half a job it did not do.
				say(t("splash.wallpaperFailed", { kb }), true);
			} else {
				// Order matters: `importFiles` has already said what it did, and this
				// sentence carries the part a user cannot see — that the cover is read
				// when the document is generated, so the splash they just set is not
				// the splash in the page they are looking at.
				say(t(wallpapered ? "splash.storedBoth" : "splash.stored", { kb }), false);
			}
		}
		sync();
	}

	/** Forget the splash and let the host delete its bytes. */
	async function clearSplash() {
		say(t("splash.clearing"), false);
		const result = await splash.clear();
		if (result.ok === true) {
			splashInfo = { configured: false, kind: null, bytes: 0, source: "off" };
			say(t(result.cleared ? "splash.cleared" : "splash.nothingToClear"), false);
		} else {
			say(t(splashErrorKey(result.reason)), true);
		}
		sync();
	}

	/**
	 * Switch back to the clip the plugin ships with.
	 *
	 * The panel does not know how big that clip is or how long it runs — the host
	 * is the one serving it, so the answer is re-read from the host rather than
	 * guessed at here. `thumbVersion` moves first so the preview re-fetches
	 * instead of painting the file it just stopped serving.
	 */
	async function resetToBuiltin() {
		// Read the previous state *before* the call, because that is what decides
		// whether anything was actually lost. Saying "removed" when nothing was
		// there is noise; saying nothing when a user's own clip was deleted is a
		// surprise, and this panel does not do surprises about deletions.
		const hadOwn = splashInfo.configured === true && splashInfo.source !== "builtin";
		say(t("splash.switching"), false);
		const result = await splash.useBuiltin();
		if (result.ok === true) {
			thumbVersion += 1;
			say(t(hadOwn ? "splash.builtinSetHad" : "splash.builtinSet"), false);
			refreshSplashInfo();
		} else {
			say(t(splashErrorKey(result.reason)), true);
		}
		sync();
	}

	const splashPicker = dom.filePicker("image/*,video/*", stageFiles, { multiple: false });
	const splashTargets = dom.h("div", { class: "lumen-row is-stack" });
	/** The applied splash, as itself: a crop of the picture, or the clip's first frame. */
	const splashThumb = dom.h("div", { class: "lumen-applied-thumb" });
	const splashStatusTextEl = dom.h("span", { class: "lumen-applied-text" });
	const splashStatus = dom.h("div", { class: "lumen-applied" }, [splashThumb, splashStatusTextEl]);

	/**
	 * The destination choices, rebuilt only when the staged file changes.
	 *
	 * A clip gets exactly one button rather than three, two of which would have
	 * to refuse: nothing in this plugin can make a video a wallpaper, and the
	 * engine's item kinds are pictures, gradients and URLs. Removing the
	 * impossible choices is more honest than explaining them after the fact.
	 */
	function renderTargets() {
		const key = staged === null ? null : `${staged.kind}:${staged.file.name || ""}:${Number(staged.file.size) || 0}`;
		if (key === targetsKey) return;
		targetsKey = key;
		dom.clear(splashTargets);
		if (staged === null) return;
		const kb = Math.max(1, Math.round((Number(staged.file.size) || 0) / 1024));
		const buttons = [dom.button(t("splash.apply.splash"), () => applyStaged("splash"), { small: true })];
		if (staged.kind === "image") {
			buttons.unshift(dom.button(t("splash.apply.wallpaper"), () => applyStaged("wallpaper"), { small: true }));
			buttons.push(dom.button(t("splash.apply.both"), () => applyStaged("both"), { small: true }));
		}
		dom.append(splashTargets, [
			dom.h("span", { class: "lumen-note", text: t("splash.staged", { name: staged.file.name || "?", kb }) }),
			...buttons
		]);
	}

	/** What the host says it is serving, in one line. */
	function splashStatusText() {
		if (splashInfo === null) return t("splash.unknown");
		// "Off" and "never set" are different sentences now that a splash ships
		// with the plugin: the only way to have none is to have turned it off,
		// and saying so is what stops "where did my splash go" from being a
		// mystery. A picture-less answer still says "not set" for the case where
		// the host reported nothing at all.
		if (splashInfo.configured !== true) {
			return t(splashInfo.source === "off" ? "splash.off.state" : "splash.none");
		}
		const kb = Math.max(1, Math.round((Number(splashInfo.bytes) || 0) / 1024));
		// "Built-in" is not a flavour of "clip splash": it is the one the plugin
		// installed by itself, and the only way a user learns that a startup film
		// came from this plugin rather than from somewhere else.
		const key = splashInfo.source === "builtin"
			? "splash.current.builtin"
			: splashInfo.kind === "video"
				? "splash.current.video"
				: "splash.current.image";
		return `${t(key)} · ${kb}KB`;
	}

	/**
	 * What the host is serving, as itself.
	 *
	 * The status line used to be a sentence, and a sentence is a description of
	 * a splash rather than a splash. Coming back to this section a week later,
	 * the only question worth answering is "is that still the clip I picked" —
	 * and a picture of it is the only answer that question accepts.
	 *
	 * A CLIP GETS A `<video>`, NOT A `background-image`. There is no CSS that
	 * paints frame zero of an MP4, so the element itself is what shows it: the
	 * `#t=0.1` fragment asks the browser to seek a tenth of a second in (frame
	 * zero of a real encode is often a black keyframe, which would make a
	 * perfectly good splash look broken), `preload="metadata"` keeps the whole
	 * clip off the wire, and muted/playsinline make it inert — this is a
	 * thumbnail, and nothing here should ever start playing.
	 *
	 * REBUILT ONLY WHEN THE ANSWER CHANGES. `sync()` runs on every store write,
	 * and replacing the `<video>` each time would restart a media load on every
	 * keystroke elsewhere in the panel. The signature is what the host reports,
	 * so a new upload — the only thing that can change the picture — is exactly
	 * what invalidates it. The version carried on the URL is what makes a *new*
	 * file visible: the route is one fixed path, so a same-sized replacement
	 * would otherwise be answered out of the browser's own cache and the panel
	 * would go on showing the picture the user just replaced.
	 */
	let thumbVersion = 0;
	let thumbSignature = null;
	function paintSplashThumb() {
		const configured = splashInfo !== null && splashInfo.configured === true;
		const kind = configured && splashInfo.kind === "video" ? "video" : "image";
		// The source rides in the signature as well as the size: switching from a
		// clip to the built-in one can land on an identical byte count, and the
		// preview would then keep showing the file the host just stopped serving.
		const signature = configured ? `${kind}:${splashInfo.source || "custom"}:${Number(splashInfo.bytes) || 0}:${thumbVersion}` : null;
		// Nothing to show is not a broken thumb: hide the well rather than leave
		// an empty bordered box that reads as a picture that failed to load.
		splashThumb.style.display = configured ? "" : "none";
		if (signature === thumbSignature) return;
		thumbSignature = signature;
		dom.clear(splashThumb);
		splashThumb.style.backgroundImage = "none";
		if (!configured) return;
		const source = `${MEDIA_PATH}?v=${thumbVersion}`;
		if (kind === "video") {
			splashThumb.appendChild(dom.h("video", {
				attrs: {
					// `#t=0.1` after the query: frame zero of a real encode is often a
					// black keyframe, and a black thumbnail would make a perfectly
					// good splash look broken.
					src: `${source}#t=0.1`,
					muted: true,
					playsinline: true,
					preload: "metadata",
					"aria-hidden": "true"
				}
			}));
			return;
		}
		splashThumb.style.backgroundImage = `url("${source}")`;
	}

	const splashGroup = splash === null
		? null
		: dom.h("div", { class: "lumen-card" }, [
			dom.row(t("splash.local"), t("splash.local.hint"), [
				splashPicker,
				dom.button(t("splash.choose"), () => splashPicker.click(), { small: true }),
				dom.button(t("splash.builtin"), resetToBuiltin, { small: true }),
				dom.button(t("splash.off"), clearSplash, { small: true })
			]),
			// The built-in clip is on by default, which means a user who never
			// opened this section still meets it on every start. Saying so here is
			// the difference between "a feature I did not know I had" and "a film
			// that hijacked my startup screen".
			dom.h("div", { class: "lumen-note", text: t("splash.builtin.note") }),
			splashTargets,
			splashStatus
		]);
	if (splashGroup !== null) {
		dom.acceptDrops(splashGroup, stageFiles);
		refreshSplashInfo();
	}

	// ── rotation: the headline feature ────────────────────────────────────────

	const rotationGroup = dom.h("div", { class: "lumen-card" });
	const rotationToggle = dom.toggle({
		value: false,
		onChange: (on) => {
			const state = store.getState();
			if (on && state.playlist.length === 0) {
				say(t("rotation.empty"), true);
				// Light up the empty state, which sits directly under this switch
				// and carries the fill button. The banner above explains it too,
				// but the banner can be scrolled out of view — this cannot.
				playlistEmpty.classList.add("is-refused");
				// Refuse the switch rather than arming a rotation with nothing in it.
				rotationToggle.set(false);
				return;
			}
			store.update((draft) => {
				draft.mode = on ? "rotation" : "single";
				draft.paused = false;
				if (on && draft.playlist.length > 0) {
					draft.single = { ...draft.playlist[clamp(draft.cursor, 0, draft.playlist.length - 1)] };
				}
				return draft;
			});
			engine.reschedule();
			sync();
		}
	});
	const playlistNode = dom.h("div", { class: "lumen-list" });

	/**
	 * Fill an empty playlist with the built-in recipes and arm the rotation.
	 *
	 * WHY THIS EXISTS. Turning the switch on with nothing in the list is the
	 * *first* thing a new user does, and the only correct answer used to be a
	 * refusal — right, but a dead end: the sentence explaining it lived in the
	 * banner at the very top of a long panel, so from the rotation section the
	 * switch simply snapped back and looked broken. The refusal stays (a
	 * rotation over zero entries would tick forever and change nothing), and
	 * this is the button that turns the dead end into one click.
	 *
	 * It seeds the *generated* wallpapers, never the user's own: those are the
	 * plugin's own content, they cost nothing to store, and each row can be
	 * deleted from the list. `single` is deliberately left alone, so turning
	 * the rotation back off returns the picture that was there before.
	 */
	function seedBuiltins() {
		const items = RECIPES.map((recipe) => createItem("recipe", recipe.id, "default")).filter((item) => item !== null);
		if (items.length === 0) {
			say(t("rotation.unstorable"), true);
			return;
		}
		store.update((draft) => {
			draft.playlist = items;
			draft.mode = "rotation";
			draft.paused = false;
			draft.cursor = 0;
			draft.remaining = [];
			return draft;
		});
		store.save();
		engine.reschedule();
		requestRender();
		say(t("rotation.seeded", { n: items.length }), false);
		sync();
	}

	const seedButton = dom.button(t("rotation.seed"), seedBuiltins, { small: true });
	const playlistEmpty = dom.h("div", { class: "lumen-empty-state" }, [
		dom.h("div", { class: "lumen-empty", text: t("rotation.empty") }),
		seedButton
	]);
	const orderHint = dom.h("span", { class: "lumen-note" });
	const triggerFields = dom.h("div", { class: "lumen-list" });
	const upcomingNode = dom.h("div", { class: "lumen-upcoming" });
	const countdownNode = dom.h("span", { class: "lumen-pill is-next" });
	const missedNode = dom.h("div", { class: "lumen-note is-warn" });
	const pauseButton = dom.button(t("rotation.pause"), () => {
		store.update((draft) => {
			draft.paused = !draft.paused;
			return draft;
		});
		engine.reschedule();
		sync();
	}, { small: true });
	const nextButton = dom.button(t("rotation.next"), () => {
		engine.rotate("manual");
		sync();
	}, { small: true });

	const intervalSlider = dom.slider({
		min: 5,
		max: 480,
		step: 5,
		value: 30,
		label: t("rotation.interval"),
		format: (v) => (v >= 60 ? `${(v / 60).toFixed(v % 60 === 0 ? 0 : 1)} h` : `${v} min`),
		onInput: (v) => {
			patchSchedule({ intervalMin: clamp(Math.round(v), INTERVAL_MIN, INTERVAL_MAX) });
		}
	});

	const hourlyChips = new Map();
	const hourlyChipsNode = dom.h("div", { class: "lumen-chips" });
	for (const minute of HOUR_PRESETS) {
		const chip = dom.h("button", {
			class: "lumen-seg",
			text: `:${pad2(minute)}`,
			attrs: { type: "button" },
			on: {
				click: () => {
					const current = normalizeHourlyMinutes(store.getState().schedule.atMinutes);
					const next = current.includes(minute) ? current.filter((m) => m !== minute) : [...current, minute];
					patchSchedule({ atMinutes: normalizeHourlyMinutes(next) });
				}
			}
		});
		hourlyChips.set(minute, chip);
		hourlyChipsNode.appendChild(chip);
	}

	const dailyInput = dom.h("input", { class: "lumen-inline-input", attrs: { type: "time", step: 60 } });
	dailyInput.addEventListener("change", () => {
		if (/^\d{2}:\d{2}$/.test(dailyInput.value)) patchSchedule({ atTime: dailyInput.value });
	});

	const modeControl = dom.segmented({
		options: [
			{ value: "interval", label: t("rotation.mode.interval") },
			{ value: "hourly", label: t("rotation.mode.hourly") },
			{ value: "daily", label: t("rotation.mode.daily") },
			{ value: "session", label: t("rotation.mode.session") }
		],
		onChange: (value) => patchSchedule({ mode: value })
	});
	const orderControl = dom.segmented({
		options: [
			{ value: "sequential", label: t("rotation.order.sequential") },
			{ value: "shuffle", label: t("rotation.order.shuffle") },
			{ value: "random", label: t("rotation.order.random") }
		],
		onChange: (value) => patchSchedule({ order: value })
	});
	const transitionSlider = dom.slider({
		min: TRANSITION_MIN,
		max: TRANSITION_MAX,
		step: 100,
		value: 1200,
		label: t("rotation.transition"),
		format: (v) => (v === 0 ? t("common.none") : `${(v / 1000).toFixed(1)}s`),
		onInput: (v) => patchSchedule({ transitionMs: v })
	});

	/** Re-render the playlist rows. */
	function renderPlaylist(state) {
		dom.clear(playlistNode);
		if (state.playlist.length === 0) {
			playlistNode.appendChild(playlistEmpty);
			return;
		}
		// The highlight below belongs to the refused attempt, not to the empty
		// list: once there is something to rotate it has served its purpose.
		playlistEmpty.classList.remove("is-refused");
		state.playlist.forEach((item, index) => {
			const isCurrent = state.mode === "rotation" && index === state.cursor;
			const row = dom.h("div", { class: `lumen-list-item${isCurrent ? " is-current" : ""}` }, [
				dom.h("span", { class: "lumen-list-index", text: String(index + 1) }),
				itemSwatch(item, state.tuning),
				dom.h("span", { class: "lumen-list-name", text: itemLabel(item, lang, t) }),
				dom.h("span", { class: "lumen-list-actions" }, [
					dom.button("↑", () => moveItem(index, -1), { small: true, variant: "ghost" }),
					dom.button("↓", () => moveItem(index, 1), { small: true, variant: "ghost" }),
					dom.button("×", () => removeItem(index), { small: true, variant: "ghost" })
				])
			]);
			row.addEventListener("dblclick", () => {
				engine.goTo(index, false);
				sync();
			});
			playlistNode.appendChild(row);
		});
	}

	function removeItem(index) {
		store.update((draft) => {
			draft.playlist.splice(index, 1);
			if (draft.playlist.length === 0) {
				draft.mode = "single";
				draft.cursor = 0;
				draft.remaining = [];
			} else {
				draft.cursor = clamp(draft.cursor >= index ? draft.cursor - 1 : draft.cursor, 0, draft.playlist.length - 1);
				draft.remaining = [];
			}
			return draft;
		});
		store.save();
		engine.reschedule();
		sync();
	}

	function moveItem(index, delta) {
		const target = index + delta;
		const state = store.getState();
		if (target < 0 || target >= state.playlist.length) return;
		store.update((draft) => {
			const [moved] = draft.playlist.splice(index, 1);
			draft.playlist.splice(target, 0, moved);
			if (draft.cursor === index) draft.cursor = target;
			else if (delta > 0 && draft.cursor > index && draft.cursor <= target) draft.cursor -= 1;
			else if (delta < 0 && draft.cursor < index && draft.cursor >= target) draft.cursor += 1;
			draft.remaining = [];
			return draft;
		});
		store.save();
		sync();
	}

	/** Re-render the trigger-specific controls. */
	function renderTriggerFields(state) {
		dom.clear(triggerFields);
		const schedule = normalizeSchedule(state.schedule);
		if (schedule.mode === "interval") {
			triggerFields.appendChild(dom.h("div", { class: "lumen-row is-stack" }, intervalSlider.el));
		} else if (schedule.mode === "hourly") {
			triggerFields.appendChild(dom.row(t("rotation.trigger"), t("rotation.hourly.hint"), hourlyChipsNode));
		} else if (schedule.mode === "daily") {
			triggerFields.appendChild(dom.row(t("rotation.trigger"), t("rotation.daily.at"), dailyInput));
		} else {
			triggerFields.appendChild(dom.h("div", { class: "lumen-note", text: t("rotation.session.hint") }));
		}
	}

	{
		rotationGroup.appendChild(
			dom.row(t("rotation.enable"), t("rotation.enable.hint"), rotationToggle.el)
		);
		rotationGroup.appendChild(dom.h("div", { class: "lumen-divider" }));
		rotationGroup.appendChild(
			dom.row(t("rotation.playlist"), null, dom.button(t("rotation.add"), addCurrentToList, { small: true }))
		);
		rotationGroup.appendChild(playlistNode);
		rotationGroup.appendChild(dom.h("div", { class: "lumen-divider" }));
		rotationGroup.appendChild(dom.row(t("rotation.trigger"), null, modeControl.el));
		rotationGroup.appendChild(triggerFields);
		// Order, transition and the transport controls stay available but folded:
		// they are preferences a user sets once, and unfolded they put seven
		// controls between the trigger and the countdown. `<details>` keeps that
		// one line long without a second piece of open/closed state to persist.
		const advanced = dom.h("details", { class: "lumen-advanced" });
		advanced.appendChild(dom.h("summary", { class: "lumen-advanced-summary", text: t("rotation.advanced") }));
		advanced.appendChild(dom.row(t("rotation.order"), null, [orderControl.el, orderHint]));
		advanced.appendChild(dom.h("div", { class: "lumen-row is-stack" }, transitionSlider.el));
		advanced.appendChild(dom.h("div", { class: "lumen-row" }, [
			dom.h("span", { class: "lumen-row-title", text: t("rotation.upcoming") }),
			dom.h("span", { class: "lumen-row-control" }, [pauseButton, nextButton])
		]));
		advanced.appendChild(upcomingNode);
		advanced.appendChild(missedNode);
		rotationGroup.appendChild(advanced);
	}

	// ── appearance ────────────────────────────────────────────────────────────

	/**
	 * The one slider whose direction was a trap, so it is now inverted.
	 *
	 * It used to be labelled "wash opacity" and moved the veil directly, which
	 * meant moving it RIGHT made the wallpaper fainter. The evidence that this
	 * reads backwards is in the field: a user who reported "the wallpaper is too
	 * faint" had the slider parked at 0.98 — the maximum — because more looked
	 * like better. A control that says 98% while showing 2% of the picture is not
	 * a labelling problem, it is the wrong quantity.
	 *
	 * So the slider now carries the number the user actually cares about —
	 * how much of the wallpaper is on screen — and the veil is its complement.
	 * The state field stays `wash.opacity` (the veil), because that is what the
	 * engine solves the readability floor against; only the presentation flips.
	 */
	const visibility = (opacity) => clamp(1 - opacity, VISIBILITY_MIN, VISIBILITY_MAX);
	const opacitySlider = dom.slider({
		min: VISIBILITY_MIN,
		max: VISIBILITY_MAX,
		step: 0.01,
		// The initial value is overwritten by `sync()` on the first paint; it is
		// derived from the default rather than typed out so the two cannot drift
		// and show a number the engine is not using.
		value: visibility(DEFAULT_STATE.wash.opacity),
		label: t("appearance.opacity"),
		format: (v) => `${Math.round(v * 100)}%`,
		onInput: (v) => patchWash({ opacity: clamp(1 - v, OPACITY_MIN, OPACITY_MAX) })
	});
	const opacityNote = dom.h("span", { class: "lumen-note" });
	const blurSlider = dom.slider({
		min: BLUR_MIN,
		max: BLUR_MAX,
		step: 1,
		value: 0,
		label: t("appearance.blur"),
		format: (v) => `${v}px`,
		onInput: (v) => patchWash({ blur: clamp(Math.round(v), BLUR_MIN, BLUR_MAX) })
	});
	const fitControl = dom.segmented({
		options: [
			{ value: "cover", label: t("appearance.fit.cover") },
			{ value: "contain", label: t("appearance.fit.contain") },
			{ value: "blur", label: t("appearance.fit.blur") }
		],
		onChange: (value) => patchWash({ fit: value })
	});
	const positionControl = dom.grid9({
		label: t("appearance.position"),
		cells: POSITION_CELLS.map((cell) => ({ value: cell.value, hint: t(cell.key) })),
		onChange: (value) => patchWash({ position: value })
	});
	const grainSlider = dom.slider({
		min: 0,
		max: 1,
		step: 0.01,
		value: 0.35,
		label: t("appearance.grain"),
		format: (v) => `${Math.round(v * 100)}%`,
		onInput: (v) => patchTuning({ grain: v })
	});
	const hueSlider = dom.slider({
		min: -180,
		max: 180,
		step: 1,
		value: 0,
		label: t("appearance.hue"),
		format: (v) => `${v > 0 ? "+" : ""}${v}°`,
		onInput: (v) => patchTuning({ hue: v })
	});
	const softnessSlider = dom.slider({
		min: 0,
		max: 1,
		step: 0.01,
		value: 0.5,
		label: t("appearance.softness"),
		format: (v) => `${Math.round(v * 100)}%`,
		onInput: (v) => patchTuning({ softness: v })
	});
	const autoDimToggle = dom.toggle({ value: true, onChange: (v) => patchWash({ autoDim: v }) });
	const readabilityToggle = dom.toggle({ value: true, onChange: (v) => patchWash({ readability: v }) });

	const appearanceGroup = dom.h("div", { class: "lumen-card" }, [
		dom.h("div", { class: "lumen-row is-stack" }, opacitySlider.el),
		opacityNote,
		dom.row(t("appearance.readability"), t("appearance.readability.hint"), readabilityToggle.el),
		dom.row(t("appearance.autoDim"), t("appearance.autoDim.hint"), autoDimToggle.el),
		dom.h("div", { class: "lumen-divider" }),
		dom.h("div", { class: "lumen-row is-stack" }, blurSlider.el),
		dom.row(t("appearance.fit"), null, fitControl.el),
		dom.row(t("appearance.position"), t("appearance.position.hint"), positionControl.el),
		dom.h("div", { class: "lumen-divider" }),
		dom.h("div", { class: "lumen-row is-stack" }, hueSlider.el),
		dom.h("div", { class: "lumen-row is-stack" }, softnessSlider.el),
		dom.h("div", { class: "lumen-row is-stack" }, grainSlider.el),
		dom.h("div", { class: "lumen-note", text: t("appearance.tuning.hint") })
	]);

	// ── status ────────────────────────────────────────────────────────────────

	const statusGroup = dom.h("div", { class: "lumen-card" });
	// `lumen-banner` is sticky: every message this panel reports lands in this
	// one node, and the panel is tall enough that an unscrolled message is
	// indistinguishable from no message at all. That was the real reason the
	// rotation switch "did nothing" — it had said why, 900px above the switch.
	const bannerNode = dom.h("div", { class: "lumen-note lumen-banner" });

	function renderStatus(state) {
		dom.clear(statusGroup);
		const health = store.getHealth();
		const inspect = engine.inspect();
		const rows = [
			[t("status.storage"), health.hostAvailable ? t("status.storage.host") : t("status.storage.local")],
			[t("status.dom"), inspect.active ? t("status.on") : t("status.off")],
			[t("status.wash"), inspect.washed === false ? t("status.off") : t("status.on")],
			[t("status.motion"), inspect.reducedMotion ? t("status.on") : t("status.off")],
			[t("status.regime"), state.mode === "rotation" ? (state.paused ? t("rotation.paused") : t("rotation.enable")) : t("status.regime.fixed")]
		];
		for (const [key, value] of rows) {
			statusGroup.appendChild(dom.h("div", { class: "lumen-kv" }, [dom.h("span", { text: key }), dom.h("b", { text: value })]));
		}
		// The single most useful line in this panel when the wallpaper "does
		// nothing": the layer can be perfect and still be invisible behind an
		// opaque shell. 1.0.1 shipped exactly that — the wash was never
		// published, because the built-in themes carry no tokens to read.
		if (inspect.washed === false) {
			statusGroup.appendChild(dom.h("div", { class: "lumen-note is-warn", text: t("status.washBlocked") }));
		}
		if (!health.hostAvailable && health.hostReason) {
			statusGroup.appendChild(dom.h("div", { class: "lumen-note is-warn", text: `${t("status.reason")}: ${health.hostReason}` }));
		}
		if (!health.hasStorage) {
			statusGroup.appendChild(dom.h("div", { class: "lumen-note is-warn", text: t("status.noStorage") }));
		}
		statusGroup.appendChild(dom.h("div", { class: "lumen-note", text: t("status.diagnostics") }));
	}

	// ── assembly & sync ───────────────────────────────────────────────────────

	const root = dom.h("div", { class: "lumen-root" }, [
		bannerNode,
		dom.group(t("group.current")),
		heroNode,
		dom.group(t("group.builtin"), t("group.builtin.hint")),
		builtinGroup,
		dom.group(t("group.custom")),
		customGroup,
		splash === null ? null : dom.group(t("group.splash"), t("group.splash.hint")),
		splashGroup,
		dom.group(t("group.rotation")),
		rotationGroup,
		dom.group(t("group.appearance")),
		appearanceGroup,
		dom.group(t("group.status")),
		statusGroup
	]);

	/** Push current state into every control. */
	function sync() {
		if (destroyed) return;
		const state = store.getState();
		const item = currentItem(state);
		const schedule = normalizeSchedule(state.schedule);
		const now = Date.now();

		// hero
		const background = itemToBackground(item, state.tuning);
		heroPreview.style.backgroundImage = background === null ? "none" : background.image;
		heroPreview.style.backgroundColor = background === null ? "transparent" : background.color;
		const photo = isPhotoItem(item);
		heroName.textContent = itemLabel(item, lang, t);
		// An illustration has no seed to show and no "generated" kind to claim.
		heroSub.textContent = photo
			? t("kind.photo")
			: `${t(`kind.${item.kind}`)} · ${t("hero.seed")} ${item.seed}`;
		if (shakeButton !== null) shakeButton.style.display = photo ? "none" : "";

		// banner
		bannerNode.textContent = banner.text === null ? "" : banner.text;
		bannerNode.className = `lumen-note lumen-banner${banner.warn ? " is-warn" : ""}`;
		bannerNode.style.display = banner.text === null ? "none" : "";

		// recipe chips
		for (const [id, entry] of recipeChips) {
			const active = item.kind === "recipe" && item.ref === id;
			entry.chip.classList.toggle("is-on", active);
			// Show the real picture and seed for the selected chip, and a neutral
			// "what this recipe looks like" render for the rest.
			const seed = active ? item.seed : "preview";
			const preview = renderRecipe({ recipeId: id, seed, tuning: state.tuning });
			entry.art.style.backgroundImage = preview.backgroundImage;
			entry.art.style.backgroundColor = preview.backgroundColor;
		}

		// custom
		const appliedSource = item.kind === "image" || item.kind === "url" ? item.ref : null;
		if (appliedSource === null) {
			imageHint.style.display = "none";
		} else {
			imageHint.style.display = "";
			// The value already passed `isSafeBackgroundImage` on the way in — no
			// quotes, parens or whitespace — so it cannot escape this url("…").
			appliedThumb.style.backgroundImage = `url("${appliedSource}")`;
			appliedText.textContent = item.kind === "image"
				? t("custom.applied.image", { kb: dataUrlKb(item.ref) })
				: t("custom.applied.url", { host: itemLabel(item, lang, t) });
		}

		// splash
		if (splashGroup !== null) {
			renderTargets();
			splashTargets.style.display = staged === null ? "none" : "";
			splashStatusTextEl.textContent = splashStatusText();
			splashStatus.className = `lumen-applied${splashInfo === null ? " is-warn" : ""}`;
			paintSplashThumb();
		}

		// rotation
		rotationToggle.set(state.mode === "rotation");
		modeControl.set(schedule.mode);
		orderControl.set(schedule.order);
		orderHint.textContent = schedule.order === "shuffle"
			? t("rotation.order.hint.shuffle")
			: schedule.order === "random"
			? t("rotation.order.hint.random")
			: "";
		intervalSlider.set(schedule.intervalMin);
		transitionSlider.set(schedule.transitionMs);
		for (const [minute, chip] of hourlyChips) {
			const on = schedule.atMinutes.includes(minute);
			chip.classList.toggle("is-on", on);
		}
		dailyInput.value = schedule.atTime;
		pauseButton.textContent = state.paused ? t("rotation.resume") : t("rotation.pause");
		pauseButton.disabled = state.mode !== "rotation";
		nextButton.disabled = state.playlist.length === 0;
		renderPlaylist(state);
		renderTriggerFields(state);

		// upcoming
		dom.clear(upcomingNode);
		if (schedule.mode === "session") {
			upcomingNode.appendChild(dom.h("span", { class: "lumen-note", text: t("rotation.session.noClock") }));
		} else if (state.mode === "rotation" && state.paused !== true) {
			const list = upcomingTriggers(schedule, now, 3);
			list.forEach((ts, index) => {
				upcomingNode.appendChild(dom.h("span", {
					class: `lumen-pill${index === 0 ? " is-next" : ""}`,
					text: formatClockStamp(ts, now)
				}));
			});
			if (list.length > 0) upcomingNode.appendChild(countdownNode);
		} else {
			upcomingNode.appendChild(dom.h("span", { class: "lumen-note", text: t("rotation.enable.hint") }));
		}
		const missed = engine.inspect().plan.missed;
		missedNode.textContent = missed > 1 && state.mode === "rotation" ? t("rotation.missed", { n: missed }) : "";
		missedNode.style.display = missed > 1 ? "" : "none";

		// appearance
		opacitySlider.set(visibility(state.wash.opacity));
		blurSlider.set(state.wash.blur);
		fitControl.set(state.wash.fit);
		positionControl.set(state.wash.position);
		grainSlider.set(state.tuning.grain);
		hueSlider.set(state.tuning.hue);
		softnessSlider.set(state.tuning.softness);
		autoDimToggle.set(state.wash.autoDim);
		readabilityToggle.set(state.wash.readability);
		const required = engine.inspect().requiredAlpha;
		if (state.wash.readability && required > state.wash.opacity + 0.005) {
			// The floor is solved in veil terms, but the slider is in picture
			// terms now, so the message is translated rather than echoed: reading
			// "raised to 43%" next to a slider showing 57% would look like a bug.
			opacityNote.textContent = t("appearance.raised", { n: Math.round((1 - required) * 100) });
			opacityNote.className = "lumen-note is-warn";
		} else {
			opacityNote.textContent = t("appearance.opacity.hint");
			opacityNote.className = "lumen-note";
		}

		renderStatus(state);
	}

	/** The 1s countdown, kept out of `sync` so it does not rebuild the panel. */
	function tickCountdown() {
		if (destroyed) return;
		const state = store.getState();
		const schedule = normalizeSchedule(state.schedule);
		if (state.mode !== "rotation" || state.paused === true || schedule.mode === "session") {
			countdownNode.textContent = "";
			return;
		}
		if (state.nextAt <= 0) {
			countdownNode.textContent = "";
			return;
		}
		const remaining = state.nextAt - Date.now();
		if (remaining <= 0) {
			countdownNode.textContent = t("rotation.due");
			return;
		}
		countdownNode.textContent = `${t("rotation.countdown")} ${formatDuration(remaining, t)}`;
	}

	// `subscribe` fires on every store change, including ones this panel caused —
	// `sync()` is idempotent, so that is cheaper than tracking who changed what.
	const unsubscribe = store.subscribe(() => sync());
	sync();
	if (win !== null && typeof win.setInterval === "function") ticker = win.setInterval(tickCountdown, TICK_MS);
	tickCountdown();

	return {
		el: root,
		sync,
		/** Stop listening and clear timers. */
		destroy() {
			destroyed = true;
			unsubscribe();
			if (ticker !== null && win !== null) win.clearInterval(ticker);
			ticker = null;
			// The toast lives on `document.body`, outside this panel's subtree, so
			// unmounting the section would otherwise leave it floating over the
			// app until its timer expired.
			if (toastTimer !== null) clearTimeout(toastTimer);
			toastTimer = null;
			if (toastNode !== null && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode);
			toastNode = null;
		}
	};
}

module.exports = { createPanel, itemLabel, formatDuration, formatClockStamp };
