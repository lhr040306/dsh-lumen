/**
 * The plugin's domain types.
 *
 * These describe what actually crosses a boundary: the document that reaches
 * disk, the entry that reaches the renderer, and the schedule the timer obeys.
 * They are hand-written to match `src/state.cjs`, `src/wallpapers.cjs` and
 * `src/scheduler.cjs`, and the unit tests are what keep the two in step —
 * `tests/state.test.cjs` in particular asserts that the persisted field list is
 * exactly the state's own field list, so a field cannot be added on one side
 * only.
 */

/** How the picture meets the viewport. */
export type FitMode = "cover" | "contain" | "blur";

/**
 * Where the subject sits inside the viewport — the nine CSS
 * `background-position` keywords, written `<vertical> <horizontal>` for a
 * corner. `"center"` is the default.
 */
export type WashPosition =
	| "center"
	| "top"
	| "bottom"
	| "left"
	| "right"
	| "top left"
	| "top right"
	| "bottom left"
	| "bottom right";

/** What a wallpaper entry can be. */
export type ItemKind = "recipe" | "image" | "url" | "gradient";

/**
 * One wallpaper.
 * `ref` is a recipe id, a data URL, an http(s) address, or a CSS gradient,
 * depending on `kind`. `seed` selects a variation of a recipe; `"default"` means
 * "the recipe's canonical rendering".
 */
export interface WallpaperItem {
	id: string;
	kind: ItemKind;
	ref: string;
	seed: string;
	/**
	 * The measured relative luminance of a LOCAL picture, 0..1, or `null` when
	 * there is no measurement.
	 *
	 * Only `image` entries can carry one, because only a locally imported
	 * picture is ever decoded (`src/image.cjs` measures it at import).
	 * `null` is not interchangeable with `0`: `null` means "unmeasured, fall
	 * back to the neutral constant", while `0` is pure black — the one value at
	 * which the readability floor stops protecting anything.
	 */
	luminance: number | null;
}

/** How opaque the wash is, and how the picture is fitted. */
export interface Wash {
	/** User-chosen opacity, solved upward by the readability floor. */
	opacity: number;
	blur: number;
	fit: FitMode;
	/** Where the subject sits. Only visible when the fit does not fill the viewport. */
	position: WashPosition;
	/** Raise the opacity automatically on a busy picture. */
	autoDim: boolean;
	/** Solve the wash floor for WCAG AA contrast. */
	readability: boolean;
}

/** The three knobs that regenerate a recipe in place. */
export interface Tuning {
	/** Hue rotation in degrees, -180..180. */
	hue: number;
	/** 0..1, spreads the light sources. */
	softness: number;
	/** 0..1, film-grain strength. */
	grain: number;
}

/** How the rotation advances. */
export type OrderMode = "sequential" | "shuffle" | "random";

/** What triggers a rotation step. */
export type ScheduleMode = "interval" | "hourly" | "daily" | "session";

/** The rotation clock. */
export interface Schedule {
	mode: ScheduleMode;
	order: OrderMode;
	/** `interval` mode: minutes between steps. */
	intervalMin: number;
	/** `hourly` mode: minutes past the hour that trigger a step. */
	atMinutes: number[];
	/** `daily` mode: local wall-clock time, `"HH:MM"`. */
	atTime: string;
	/** Cross-fade duration, ms. `0` disables the animation. */
	transitionMs: number;
	/** Grid anchor for `interval` mode, so steps land on round times. */
	anchorAt: number;
}

/** The persisted document. */
export interface State {
	/** `single` shows one wallpaper; `rotation` walks the playlist. */
	mode: "single" | "rotation";
	single: WallpaperItem;
	playlist: WallpaperItem[];
	cursor: number;
	/** Shuffle's remaining queue, so no entry repeats until all are used. */
	remaining: number[];
	/** Bumped when the order changes, so a stale queue is discarded. */
	orderRevision: number;
	/** Monotonic counter seeding the `random` order's stream. */
	orderStep: number;
	/** Unix ms of the next due trigger; `0` means "not armed". */
	nextAt: number;
	paused: boolean;
	wash: Wash;
	tuning: Tuning;
	schedule: Schedule;
	/** Whether the user has ever touched the wash, so a default can be improved. */
	washTouched: boolean;
}

/** A built-in wallpaper recipe's metadata. */
export interface Recipe {
	id: string;
	name: { zh: string; en: string };
	/** Which theme the recipe is designed for; it still renders in the other. */
	scheme: "dark" | "light";
	tags: string[];
	/** 0..1, how busy the picture is — drives the auto-dim wash lift. */
	complexity: number;
}

/** What the renderer needs to paint one recipe. */
export interface RenderedRecipe {
	backgroundImage: string;
	backgroundColor: string;
	scheme: string;
	complexity: number;
	recipeId: string;
	seed: string;
}

/** Why a wallpaper image was refused. */
export type ImageErrorCode = "not-an-image" | "too-large" | "decode-failed" | "still-too-large" | "no-canvas";

/** Persistence health, surfaced in the panel's status block. */
export interface StoreHealth {
	hostAvailable: boolean;
	hostReason: string | null;
	lastError: string | null;
	hasStorage: boolean;
}
