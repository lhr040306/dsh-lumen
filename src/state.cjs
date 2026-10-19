"use strict";
/**
 * The state model: one shape, one normalizer, one serialisation.
 *
 * WHY A NORMALIZER RATHER THAN TRUSTING THE STORE
 *
 * Everything that reaches this module came through a text channel — a JSON
 * settings file on disk, `localStorage`, or a hand-edited value. Any of those
 * can be stale (written by a future build), truncated, or hostile (a page
 * script writing into the same origin's storage). Every downstream consumer —
 * the CSS string builder, the timer, the token override — assumes its input is
 * already the right shape, so the normalization happens ONCE, here, and every
 * field is clamped into its domain rather than merely type-checked. A wallpaper
 * slider that reads `3.4` is not an error to report, it is a 1.0 to render.
 *
 * TWO STORAGE TIERS, ON PURPOSE
 *
 * The obvious alternative — one flat map holding every preference *and* the
 * multi-megabyte wallpaper data URLs — also works, but it puts the whole
 * document at risk from one oversized value: a 6MB photo can push the nearest
 * storage quota over the line and take the user's *other* settings down with
 * it. Here the preferences live in one small JSON document and images live in
 * their own keys (`blob:<id>` host-side, `dsh-lumen:blob:<id>` in the browser
 * seed), so an image that will not fit fails alone — the playlist, the schedule
 * and the wash are untouched.
 */

const { isRecipeId, RECIPE_IDS } = require("./wallpapers.cjs");
const { normalizeSchedule } = require("./scheduler.cjs");

/** Schema version of the persisted document. Bump only with a migration. */
const SCHEMA = 1;
/** Longest playlist we will persist (a rotation nobody can see all of is a bug). */
const MAX_PLAYLIST = 24;
/** Largest stored image, in characters of data URL (~6MB of base64). */
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
/** Longest custom gradient string accepted. */
const MAX_GRADIENT_CHARS = 600;
/** Longest wallpaper URL accepted. */
const MAX_URL_CHARS = 2048;
/** Longest seed string accepted. */
const MAX_SEED_CHARS = 64;

/** What a playlist entry can be. */
const ITEM_KINDS = ["recipe", "image", "url", "gradient"];

/** Wash opacity bounds — below 0.2 the chrome stops occluding anything. */
const OPACITY_MIN = 0.2;
const OPACITY_MAX = 0.98;
/**
 * The veil opacity 1.0.x shipped as its default.
 *
 * Kept as a named constant rather than a literal in the migration because it is
 * history, not a tuning value: it exists so the migration has something exact to
 * recognise, and so removing it later is a visible decision rather than a silent
 * one.
 */
const LEGACY_WASH_OPACITY = 0.5;
/**
 * The same bounds expressed the way the panel presents them: how much of the
 * picture is on screen. `wash.opacity` is the veil, so these are its complements
 * — derived rather than written out twice, because two constants that have to
 * add up to 1 are two constants that eventually do not.
 *
 * Rounded because `1 - 0.98` is `0.020000000000000018` in binary floating point,
 * and a slider whose minimum is that shows up as a step grid offset from the
 * numbers it prints.
 */
const VISIBILITY_MIN = Math.round((1 - OPACITY_MAX) * 100) / 100;
const VISIBILITY_MAX = Math.round((1 - OPACITY_MIN) * 100) / 100;
/** Blur bounds, px. Past 60 the picture is a colour field, not a picture. */
const BLUR_MIN = 0;
const BLUR_MAX = 60;
/** How the picture meets the viewport. */
const FIT_MODES = ["cover", "contain", "blur"];

/**
 * Where the picture sits inside the viewport, as a nine-point grid.
 *
 * A grid rather than free `background-position` offsets because the reason this
 * exists is concrete and coarse: DSH keeps a sidebar down the left edge, so a
 * centred subject often ends up underneath it. "Move the subject off the
 * sidebar" is nine choices, not two sliders.
 */
const WASH_POSITIONS = [
	"center",
	"top",
	"bottom",
	"left",
	"right",
	"top left",
	"top right",
	"bottom left",
	"bottom right"
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finiteOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

const DEFAULT_STATE = Object.freeze({
	mode: "single",
	single: Object.freeze({ kind: "recipe", ref: "drift", seed: "default" }),
	playlist: Object.freeze([]),
	cursor: 0,
	remaining: Object.freeze([]),
	orderRevision: 1,
	/** Monotonic counter feeding the order-mode randomness (see scheduler.stepCursor). */
	orderStep: 0,
	nextAt: 0,
	/** User-requested hold on the rotation. Distinct from `mode`, which is
	 *  "is there a rotation configured at all" — pausing must not lose it. */
	paused: false,
	wash: Object.freeze({
		// One veil, not a stack. 0.5 was the first guess and it read as "the page
		// has a tint" rather than "there is a wallpaper": on a light theme the
		// veil is white, so 0.5 plus the automatic lift left the picture only 44%
		// visible and the window looked washed out. 0.3 leaves roughly two thirds
		// of the picture — enough that the change is legible at a glance — and
		// the AA floor below still raises it per picture wherever text would
		// genuinely suffer.
		opacity: 0.3,
		blur: 0,
		fit: "cover",
		position: "center",
		autoDim: true,
		readability: true
	}),
	tuning: Object.freeze({ hue: 0, softness: 0.5, grain: 0.35 }),
	schedule: Object.freeze(normalizeSchedule({ mode: "interval", intervalMin: 30 })),
	/** Set once the user touches a wash slider: recipe/wallpaper changes then
	 *  stop retuning the appearance for them. */
	washTouched: false
});

/** Accepted characters in a custom gradient, plus the required leading function. */
const GRADIENT_ALLOWED = /^[A-Za-z0-9#%.,()+\- ]+$/;
const GRADIENT_HEAD = /^(linear-gradient|radial-gradient|conic-gradient)\(/;

/**
 * Whether a string is a gradient this plugin is willing to put into a
 * `background-image`.
 *
 * An allow-list of characters, not a deny-list of attacks. The value is
 * interpolated into a CSS declaration, so the only safe question is "does this
 * string consist entirely of things that can appear inside a gradient?" —
 * which excludes `;` (declaration escape), `:` (so no `url()` and no `data:`
 * smuggling), `/` and `*` (comment tricks), quotes and angle brackets. Balanced
 * parentheses are checked too, since an unbalanced `(` swallows the rest of the
 * stylesheet.
 */
function isSafeGradient(value) {
	if (typeof value !== "string") return false;
	const text = value.trim();
	if (text.length === 0 || text.length > MAX_GRADIENT_CHARS) return false;
	if (!GRADIENT_HEAD.test(text)) return false;
	if (!text.endsWith(")")) return false;
	if (!GRADIENT_ALLOWED.test(text)) return false;
	let depth = 0;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/** Remote wallpapers are http(s) only — `file:`/`javascript:`/`blob:` are out. */
function isSafeWallpaperUrl(value) {
	if (typeof value !== "string") return false;
	const text = value.trim();
	if (text.length === 0 || text.length > MAX_URL_CHARS) return false;
	if (!/^https?:\/\//i.test(text)) return false;
	// Reject characters that would break out of the CSS `url("…")` wrapping.
	return !/["'()\\\s]/.test(text.slice(text.indexOf("//") + 2));
}

/** Local pictures are stored as `data:image/<type>;base64,<payload>`. */
function isSafeDataImage(value) {
	if (typeof value !== "string") return false;
	if (value.length > MAX_IMAGE_CHARS) return false;
	if (!/^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
	return true;
}

/** Longest composed `background-image` value accepted (a real generated stack). */
const MAX_BACKGROUND_CSS_CHARS = 65536;
/** Accepted characters in a composed gradient stack. */
const BACKGROUND_CSS_ALLOWED = /^[A-Za-z0-9#%.,()+\- ]+$/;

/**
 * Whether a composed `background-image` value may be written into the DOM.
 *
 * The engine builds these strings itself, so this is belt-and-braces — but the
 * cost of being wrong is a CSS injection, and the cost of checking is a regex.
 * A generated value and a hostile one are told apart by shape:
 *
 *   - exactly one `url("…")` layer, whose payload must itself pass the data-URL
 *     or http(s) validator, or
 *   - a `-gradient(` stack built only from the characters a gradient can
 *     contain, with balanced parentheses.
 *
 * Note the character class excludes `:`, `/` and `;`, which is what rules out
 * `url()` smuggling, a declaration escape, and a comment trick respectively.
 */
function isSafeBackgroundImage(value) {
	if (typeof value !== "string") return false;
	const text = value.trim();
	if (text.length === 0) return false;
	if (/^url\(/i.test(text)) {
		const match = text.match(/^url\("([^"]*)"\)$/);
		if (match === null) return false;
		// The payload validator owns the length limit in this branch, and it has
		// to: a photograph is legitimately far bigger than any sane gradient
		// stack, and the 64KB ceiling below was cutting real wallpapers off.
		// That is not a theoretical edge — a 2560px JPEG is ~120KB of base64,
		// which the shipped build refused with "unsafe background-image" and the
		// engine then painted nothing at all.
		return isSafeDataImage(match[1]) || isSafeWallpaperUrl(match[1]);
	}
	if (text.length > MAX_BACKGROUND_CSS_CHARS) return false;
	if (!/^(linear|radial|conic)-gradient\(/i.test(text)) return false;
	if (!text.endsWith(")")) return false;
	if (!BACKGROUND_CSS_ALLOWED.test(text)) return false;
	let depth = 0;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/** Kinds whose `ref` is a big payload that belongs in its own storage key. */
function isBlobKind(kind) {
	return kind === "image";
}

/** Truncate a seed to something storable, falling back to the default. */
function normalizeSeed(value) {
	if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, MAX_SEED_CHARS);
	if (typeof value !== "string") return "default";
	const text = value.trim();
	if (text.length === 0) return "default";
	return text.slice(0, MAX_SEED_CHARS);
}

/**
 * A measured relative luminance, or `null` when there is no measurement.
 *
 * `null` is a real answer here and is kept distinct from "dark": a remote
 * picture the plugin never decoded has no measurable brightness, and pretending
 * it does would hide the fact that the readability floor is working from a
 * constant for it. The engine reads `null` as "fall back", not as "zero".
 *
 * Strictly typed on purpose — `Number(null)` is `0`, so a lenient conversion
 * would quietly turn "unmeasured" into "pure black", which is the one value
 * that switches the readability floor off.
 */
function normalizeLuminance(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < 0 || value > 1) return null;
	return Math.round(value * 1000) / 1000;
}

/**
 * Validate and repair one playlist entry.
 * @returns {object|null} `null` when the entry cannot be made to mean anything.
 */
function normalizeItem(input) {
	if (!input || typeof input !== "object") return null;
	const kind = ITEM_KINDS.includes(input.kind) ? input.kind : null;
	if (kind === null) return null;
	let ref = input.ref;
	if (kind === "recipe") {
		ref = isRecipeId(ref) ? ref : null;
		// An unknown recipe id is repaired to the first recipe rather than
		// dropped: the entry still means "a built-in wallpaper", and silently
		// shrinking a playlist is worse than showing a substitute.
		if (ref === null) ref = RECIPE_IDS[0];
	} else if (kind === "image") {
		ref = isSafeDataImage(ref) ? ref : null;
	} else if (kind === "url") {
		ref = isSafeWallpaperUrl(ref) ? ref.trim() : null;
	} else if (kind === "gradient") {
		ref = isSafeGradient(ref) ? ref.trim() : null;
	}
	if (ref === null) return null;
	return {
		id: typeof input.id === "string" && input.id.length > 0 && input.id.length <= 64 ? input.id : createItemId(),
		kind,
		ref,
		seed: normalizeSeed(input.seed),
		luminance: normalizeLuminance(input.luminance)
	};
}

let idCounter = 0;
/** A short unique id for a playlist entry. */
function createItemId() {
	idCounter += 1;
	return `itm_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Build a playlist entry from loose arguments. Returns `null` if invalid.
 * `luminance` is the optional measurement from `image.prepareImage`.
 */
function createItem(kind, ref, seed, luminance) {
	return normalizeItem({ kind, ref, seed, luminance });
}

/** A default state object (deep, mutable copy). */
function defaultState() {
	return {
		...DEFAULT_STATE,
		single: { ...DEFAULT_STATE.single },
		playlist: [],
		remaining: [],
		wash: { ...DEFAULT_STATE.wash },
		tuning: { ...DEFAULT_STATE.tuning },
		schedule: { ...DEFAULT_STATE.schedule }
	};
}

/** Normalize the wash sub-record. */
function normalizeWash(input) {
	const raw = input && typeof input === "object" ? input : {};
	return {
		opacity: clamp(finiteOr(raw.opacity, DEFAULT_STATE.wash.opacity), OPACITY_MIN, OPACITY_MAX),
		blur: clamp(Math.round(finiteOr(raw.blur, DEFAULT_STATE.wash.blur)), BLUR_MIN, BLUR_MAX),
		fit: FIT_MODES.includes(raw.fit) ? raw.fit : DEFAULT_STATE.wash.fit,
		position: WASH_POSITIONS.includes(raw.position) ? raw.position : DEFAULT_STATE.wash.position,
		autoDim: raw.autoDim !== false,
		readability: raw.readability !== false
	};
}

/** Normalize the tuning record (the three "shake-able" knobs). */
function normalizeTuning(input) {
	const raw = input && typeof input === "object" ? input : {};
	return {
		hue: clamp(finiteOr(raw.hue, DEFAULT_STATE.tuning.hue), -180, 180),
		softness: clamp01(finiteOr(raw.softness, DEFAULT_STATE.tuning.softness)),
		grain: clamp01(finiteOr(raw.grain, DEFAULT_STATE.tuning.grain))
	};
}

/**
 * Coerce anything into a renderable state.
 * Never throws; never returns a state the renderer cannot consume.
 */
function normalizeState(input) {
	const raw = input && typeof input === "object" ? input : {};
	const playlist = Array.isArray(raw.playlist)
		? raw.playlist.map(normalizeItem).filter((item) => item !== null).slice(0, MAX_PLAYLIST)
		: [];
	const single = normalizeItem(raw.single) || { ...DEFAULT_STATE.single, id: createItemId() };
	const cursor = playlist.length === 0 ? 0 : clamp(Math.floor(finiteOr(raw.cursor, 0)), 0, playlist.length - 1);
	const remaining = Array.isArray(raw.remaining)
		? raw.remaining
				.map((v) => Math.floor(Number(v)))
				.filter((v) => Number.isInteger(v) && v >= 0 && v < playlist.length)
		: [];
	const wash = normalizeWash(raw.wash);
	const washTouched = raw.washTouched === true;
	// A NEW DEFAULT HAS TO REACH THE PEOPLE WHO ALREADY HAVE THE OLD ONE.
	//
	// Changing `DEFAULT_STATE.wash.opacity` only helps a fresh install: anyone
	// who ran 1.0.x already carries 0.5 in their saved state, and normalizing
	// would faithfully keep painting the washed-out veil they are complaining
	// about. So the old default is treated as "never chose anything" — but only
	// that exact value, and only for a user who has never moved a wash slider,
	// which is what `washTouched` records. A number somebody picked on purpose
	// is never rewritten.
	if (washTouched === false && raw.wash && raw.wash.opacity === LEGACY_WASH_OPACITY) {
		wash.opacity = DEFAULT_STATE.wash.opacity;
	}
	return {
		mode: raw.mode === "rotation" && playlist.length > 0 ? "rotation" : "single",
		single,
		playlist,
		cursor,
		remaining,
		orderRevision: Math.max(1, Math.floor(finiteOr(raw.orderRevision, 1))),
		orderStep: Math.max(0, Math.floor(finiteOr(raw.orderStep, 0))),
		nextAt: Math.max(0, finiteOr(raw.nextAt, 0)),
		paused: raw.paused === true,
		wash,
		tuning: normalizeTuning(raw.tuning),
		schedule: normalizeSchedule(raw.schedule),
		washTouched
	};
}

/**
 * The entry the renderer should show right now.
 * In `single` mode that is `state.single`; in `rotation` mode the cursor's
 * entry, falling back to `single` when the playlist is somehow empty.
 */
function currentItem(state) {
	if (state.mode === "rotation" && state.playlist.length > 0) {
		return state.playlist[clamp(state.cursor, 0, state.playlist.length - 1)] || state.single;
	}
	return state.single;
}

/** A one-line human description of an entry, for the playlist UI. */
function describeItem(item) {
	if (!item) return "";
	if (item.kind === "recipe") return `${item.seed === "default" ? "" : `${item.seed} · `}${item.ref}`;
	if (item.kind === "url") {
		try {
			return new URL(item.ref).hostname;
		} catch {
			return "url";
		}
	}
	if (item.kind === "image") return `image ${Math.round(item.ref.length / 1024)}KB`;
	return "gradient";
}

/** Storage key prefix for a blob-backed entry (`image` kinds). */
function blobKey(itemId) {
	return `blob:${itemId}`;
}

/**
 * The preference fields that each get their own storage key.
 *
 * WHY ONE KEY PER FIELD RATHER THAN ONE DOCUMENT
 *
 * The host API merges a patch: a key that is absent keeps whatever it had, and
 * an explicit `null` deletes. That is only useful if the keys are fine-grained
 * enough for two writers to touch different ones. With the whole document under
 * a single `state` key, every write necessarily carries every preference — so a
 * second DSH window (which shares `$DSH_HOME/lumen.json` but sits on its own
 * origin) silently reverts the first window's wash, tuning and schedule the
 * moment it changes anything. Chunking per field is what makes "merge" mean
 * something, and it costs one extra key per preference.
 *
 * The field list mirrors `DEFAULT_STATE`; the state test pins the two together
 * so a field added later cannot silently fall out of persistence.
 */
const DOC_KEYS = ["mode", "single", "playlist", "cursor", "remaining", "orderRevision", "orderStep", "nextAt", "paused", "wash", "tuning", "schedule", "washTouched"];

/** Storage key holding the document's schema stamp. */
const SCHEMA_KEY = "schema";

/**
 * Split a state into the flat string map the host persistence API accepts.
 *
 * Every preference gets its own key as JSON, and every `image` entry's payload
 * gets its own `blob:<id>` key. The rules the host API enforces (string values
 * only, `null` to delete) then apply to each field independently.
 */
function toStore(state) {
	const normalized = normalizeState(state);
	const map = { [SCHEMA_KEY]: String(SCHEMA) };
	const doc = {
		mode: normalized.mode,
		cursor: normalized.cursor,
		remaining: normalized.remaining,
		orderRevision: normalized.orderRevision,
		orderStep: normalized.orderStep,
		nextAt: normalized.nextAt,
		paused: normalized.paused,
		wash: normalized.wash,
		tuning: normalized.tuning,
		schedule: normalized.schedule,
		washTouched: normalized.washTouched,
		single: stripPayload(normalized.single),
		playlist: normalized.playlist.map(stripPayload)
	};
	for (const key of DOC_KEYS) map[key] = JSON.stringify(doc[key]);
	for (const item of normalized.playlist) {
		if (isBlobKind(item.kind)) map[blobKey(item.id)] = item.ref;
	}
	if (isBlobKind(normalized.single.kind)) map[blobKey(normalized.single.id)] = normalized.single.ref;
	return map;
}

/** Replace a blob payload with a marker so the JSON document stays small. */
function stripPayload(item) {
	if (isBlobKind(item.kind)) {
		// `luminance` rides along in the document rather than beside the payload:
		// it is a few bytes of measurement, and putting it in the blob key would
		// mean a picture whose payload was pruned loses its readability floor too.
		return { id: item.id, kind: item.kind, ref: null, seed: item.seed, luminance: item.luminance, hasBlob: true };
	}
	return item;
}

/**
 * Rebuild a state from the flat string map, re-attaching blob payloads.
 *
 * A PARTIAL map is the normal case, not an exception: the host merges patches,
 * so a field the user never touched is genuinely absent and must fall back to
 * the current build's default (which is exactly how a default improves for
 * users who never overrode it). A missing blob leaves the entry "unresolved"
 * and it is dropped, so a half-cleaned store degrades to fewer wallpapers
 * rather than broken ones.
 *
 * The `state` key is read as a fallback for the single-document layout written
 * by builds before the per-field split. Without it, upgrading would read an
 * empty map and reset every preference to default.
 */
function fromStore(map) {
	const source = map && typeof map === "object" ? map : {};
	const legacy = (() => {
		if (typeof source.state !== "string") return null;
		try {
			const parsed = JSON.parse(source.state);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	})();
	const pick = (key) => {
		const raw = source[key];
		if (typeof raw === "string") {
			try {
				return JSON.parse(raw);
			} catch {
				// A corrupt field falls through to the legacy document rather
				// than resetting the whole state.
			}
		}
		if (legacy !== null && Object.prototype.hasOwnProperty.call(legacy, key)) return legacy[key];
		return undefined;
	};
	const reattach = (entry) => {
		if (!entry || typeof entry !== "object") return null;
		if (entry.hasBlob === true) {
			const payload = source[blobKey(entry.id)];
			if (!isSafeDataImage(payload)) return null;
			return { id: entry.id, kind: entry.kind, ref: payload, seed: entry.seed, luminance: entry.luminance };
		}
		return entry;
	};
	const playlist = pick("playlist");
	return normalizeState({
		mode: pick("mode"),
		cursor: pick("cursor"),
		remaining: pick("remaining"),
		orderRevision: pick("orderRevision"),
		orderStep: pick("orderStep"),
		nextAt: pick("nextAt"),
		paused: pick("paused"),
		wash: pick("wash"),
		tuning: pick("tuning"),
		schedule: pick("schedule"),
		washTouched: pick("washTouched"),
		single: reattach(pick("single")),
		playlist: Array.isArray(playlist) ? playlist.map(reattach).filter((entry) => entry !== null) : null
	});
}

/** Every blob key a state owns — used to prune orphaned payloads. */
function blobKeysOf(state) {
	const keys = [];
	if (isBlobKind(state.single.kind)) keys.push(blobKey(state.single.id));
	for (const item of state.playlist) if (isBlobKind(item.kind)) keys.push(blobKey(item.id));
	return keys;
}

module.exports = {
	SCHEMA,
	SCHEMA_KEY,
	DOC_KEYS,
	MAX_PLAYLIST,
	MAX_IMAGE_CHARS,
	MAX_BACKGROUND_CSS_CHARS,
	MAX_GRADIENT_CHARS,
	OPACITY_MIN,
	OPACITY_MAX,
	VISIBILITY_MIN,
	VISIBILITY_MAX,
	BLUR_MIN,
	BLUR_MAX,
	FIT_MODES,
	WASH_POSITIONS,
	ITEM_KINDS,
	DEFAULT_STATE,
	isSafeGradient,
	isSafeBackgroundImage,
	isSafeWallpaperUrl,
	isSafeDataImage,
	isBlobKind,
	normalizeSeed,
	normalizeLuminance,
	normalizeItem,
	normalizeState,
	normalizeWash,
	normalizeTuning,
	createItem,
	createItemId,
	defaultState,
	currentItem,
	describeItem,
	blobKey,
	blobKeysOf,
	toStore,
	fromStore
};
