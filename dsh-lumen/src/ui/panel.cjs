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
	MAX_PLAYLIST,
	OPACITY_MIN,
	OPACITY_MAX,
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
const { createTranslator } = require("../i18n.cjs");

/** Preset minutes-past-the-hour offered by the hourly trigger. */
const HOUR_PRESETS = [0, 15, 30, 45];
/** How often the countdown readout refreshes, ms. */
const TICK_MS = 1000;

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
		const recipe = RECIPES.find((r) => r.id === item.ref);
		const name = recipe === undefined ? item.ref : lang === "en" ? recipe.name.en : recipe.name.zh;
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

	function shake() {
		const seed = `s${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
		patchCurrent({ seed });
	}

	function copySeed() {
		const item = currentItem(store.getState());
		const text = `${item.ref}${item.seed === "default" ? "" : `#${item.seed}`}`;
		try {
			if (win !== null && win.navigator && win.navigator.clipboard) {
				win.navigator.clipboard.writeText(text);
				say(t("hero.copied"), false);
				return;
			}
		} catch {}
		say(text, false);
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
		const actions = dom.h("div", { class: "lumen-hero-actions" });
		actions.appendChild(dom.button(t("hero.shake"), shake, { small: true, hint: t("hero.shake.hint") }));
		actions.appendChild(dom.button(t("hero.copySeed"), copySeed, { small: true, variant: "ghost" }));
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
	const imageHint = dom.h("span", { class: "lumen-note" });

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
	const localRow = dom.row(t("custom.local"), t("custom.local.hint"), [
		picker,
		dom.button(t("custom.choose"), () => picker.click(), { small: true })
	]);
	// Dropping onto the row (not just the button) is what makes "drag a folder of
	// candidates in" work — the row is the thing the user aims at.
	dom.acceptDrops(localRow, importFiles);
	customGroup.appendChild(localRow);
	customGroup.appendChild(
		dom.row(t("custom.url"), t("custom.url.hint"), [dom.button(t("custom.apply"), applyUrl, { small: true })])
	);
	customGroup.appendChild(dom.h("div", { class: "lumen-row is-stack" }, urlInput));
	customGroup.appendChild(dom.h("div", { class: "lumen-divider" }));
	customGroup.appendChild(
		dom.row(t("custom.gradient"), t("custom.gradient.hint"), [
			fromInput,
			toInput,
			dom.button(t("custom.apply"), applyGradient, { small: true })
		])
	);
	customGroup.appendChild(dom.h("div", { class: "lumen-row is-stack" }, angleSlider.el));
	customGroup.appendChild(imageHint);

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
			splashInfo = { configured: false, kind: null, bytes: 0 };
			say(t(result.cleared ? "splash.cleared" : "splash.nothingToClear"), false);
		} else {
			say(t(splashErrorKey(result.reason)), true);
		}
		sync();
	}

	const splashPicker = dom.filePicker("image/*,video/*", stageFiles, { multiple: false });
	const splashTargets = dom.h("div", { class: "lumen-row is-stack" });
	const splashStatus = dom.h("div", { class: "lumen-note" });

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
		if (splashInfo.configured !== true) return t("splash.none");
		const kb = Math.max(1, Math.round((Number(splashInfo.bytes) || 0) / 1024));
		return `${t(splashInfo.kind === "video" ? "splash.current.video" : "splash.current.image")} · ${kb}KB`;
	}

	const splashGroup = splash === null
		? null
		: dom.h("div", { class: "lumen-card" }, [
			dom.row(t("splash.local"), t("splash.local.hint"), [
				splashPicker,
				dom.button(t("splash.choose"), () => splashPicker.click(), { small: true }),
				dom.button(t("splash.clear"), clearSplash, { small: true })
			]),
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
	const playlistEmpty = dom.h("div", { class: "lumen-empty", text: t("rotation.empty") });
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
		rotationGroup.appendChild(
			dom.row(t("rotation.order"), null, [orderControl.el, orderHint])
		);
		rotationGroup.appendChild(dom.h("div", { class: "lumen-row is-stack" }, transitionSlider.el));
		rotationGroup.appendChild(dom.h("div", { class: "lumen-row" }, [
			dom.h("span", { class: "lumen-row-title", text: t("rotation.upcoming") }),
			dom.h("span", { class: "lumen-row-control" }, [pauseButton, nextButton])
		]));
		rotationGroup.appendChild(upcomingNode);
		rotationGroup.appendChild(missedNode);
	}

	// ── appearance ────────────────────────────────────────────────────────────

	const opacitySlider = dom.slider({
		min: OPACITY_MIN,
		max: OPACITY_MAX,
		step: 0.01,
		value: 0.82,
		label: t("appearance.opacity"),
		format: (v) => `${Math.round(v * 100)}%`,
		onInput: (v) => patchWash({ opacity: clamp(v, OPACITY_MIN, OPACITY_MAX) })
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
	const bannerNode = dom.h("div", { class: "lumen-note" });

	function renderStatus(state) {
		dom.clear(statusGroup);
		const health = store.getHealth();
		const inspect = engine.inspect();
		const rows = [
			[t("status.storage"), health.hostAvailable ? t("status.storage.host") : t("status.storage.local")],
			[t("status.dom"), inspect.active ? t("status.on") : t("status.off")],
			[t("status.motion"), inspect.reducedMotion ? t("status.on") : t("status.off")],
			[t("status.regime"), state.mode === "rotation" ? (state.paused ? t("rotation.paused") : t("rotation.enable")) : t("status.regime.fixed")]
		];
		for (const [key, value] of rows) {
			statusGroup.appendChild(dom.h("div", { class: "lumen-kv" }, [dom.h("span", { text: key }), dom.h("b", { text: value })]));
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
		heroName.textContent = itemLabel(item, lang, t);
		heroSub.textContent = `${t(`kind.${item.kind}`)} · ${t("hero.seed")} ${item.seed}`;

		// banner
		bannerNode.textContent = banner.text === null ? "" : banner.text;
		bannerNode.className = `lumen-note${banner.warn ? " is-warn" : ""}`;
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
		imageHint.textContent = item.kind === "image" ? `${Math.round(item.ref.length / 1024)}KB` : "";
		if (item.kind === "gradient") {
			urlDraft.value = urlDraft.value;
		}

		// splash
		if (splashGroup !== null) {
			renderTargets();
			splashTargets.style.display = staged === null ? "none" : "";
			splashStatus.textContent = splashStatusText();
			splashStatus.className = `lumen-note${splashInfo === null ? " is-warn" : ""}`;
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
		opacitySlider.set(state.wash.opacity);
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
			opacityNote.textContent = t("appearance.raised", { n: Math.round(required * 100) });
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
		}
	};
}

module.exports = { createPanel, itemLabel, formatDuration, formatClockStamp };
