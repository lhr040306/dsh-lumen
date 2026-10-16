"use strict";
/**
 * The rotation scheduler — the feature this plugin exists for.
 *
 * A static wallpaper plugin answers "which picture?". This one also answers
 * "**when does it change, and what comes next**" — which turns out to need
 * four genuinely different notions of time:
 *
 *   `interval`  every N minutes, on a grid anchored the moment rotation was
 *               armed. Not "N minutes after the last change": a timer that
 *               restarts on every reload silently never fires for a user who
 *               reloads often, and it drifts away from the clock.
 *   `hourly`    at chosen minutes past each hour (e.g. :00 and :30), so the
 *               change lands on a time the user can predict and plan around.
 *   `daily`     at one local wall-clock time, for "a new picture each morning".
 *   `session`   on every fresh look at the app — driven by visibility, not by
 *               the clock, because for this mode the clock is irrelevant.
 *
 * WHY IT IS A PURE MODULE. Everything here is `(schedule, now) -> number`. The
 * awkward parts of a scheduler are all edge cases — a laptop asleep past three
 * trigger points, a device whose clock jumped backwards, a DST boundary, a
 * two-item playlist in shuffle order — and none of them can be tested honestly
 * through a `setInterval`. As pure functions they are ordinary unit tests, and
 * the browser half only has to own one timer and one wake-up check.
 *
 * CATCH-UP IS DELIBERATELY LOSSY. If the machine was asleep past five triggers,
 * the user comes back to ONE change, not five. Replaying them would flash
 * wallpapers at the user and burn CPU to reach a state that only the last one
 * mattered for. `planResume` encodes that choice in one place.
 */

const { createRng, shuffled } = require("./rng.cjs");

/** The four time models, in the order the settings panel shows them. */
const SCHEDULE_MODES = ["interval", "hourly", "daily", "session"];
/** How the playlist is walked. */
const ORDER_MODES = ["sequential", "shuffle", "random"];

/** Interval bounds, in minutes: 5 minutes .. 30 days. */
const INTERVAL_MIN = 5;
const INTERVAL_MAX = 60 * 24 * 30;
/** Transition length bounds, in ms: instant .. 4 s. */
const TRANSITION_MIN = 0;
const TRANSITION_MAX = 4000;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Local-midnight-anchored Date helpers, so wall-clock math ignores time of day. */
function startOfHour(ts) {
	const d = new Date(ts);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0).getTime();
}

function startOfDay(ts) {
	const d = new Date(ts);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/** Parse `HH:MM` into minutes-past-midnight; `null` when malformed. */
function parseClock(text) {
	if (typeof text !== "string") return null;
	const parts = text.split(":");
	if (parts.length !== 2) return null;
	const hh = Number(parts[0]);
	const mm = Number(parts[1]);
	if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
	if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
	return hh * 60 + mm;
}

/** Format minutes-past-midnight back into `HH:MM`. */
function formatClock(minutes) {
	const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
	const hh = String(Math.floor(m / 60)).padStart(2, "0");
	const mm = String(m % 60).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * Sort, de-duplicate and clamp a list of "minutes past the hour" values.
 *
 * Out-of-range values are DROPPED, not clamped. Clamping turns `-4` into `:00`
 * and `99` into `:59`, which invents triggers the user never asked for — and
 * they would appear in the "upcoming" list looking entirely deliberate.
 */
function normalizeHourlyMinutes(list) {
	const input = Array.isArray(list) ? list : [];
	const clean = input
		.map((v) => Number(v))
		.filter((v) => Number.isFinite(v))
		.map((v) => Math.round(v))
		.filter((v) => v >= 0 && v <= 59);
	const unique = Array.from(new Set(clean)).sort((a, b) => a - b);
	return unique.length > 0 ? unique : [0];
}

/**
 * Coerce an arbitrary object into a schedule this module can run.
 * Never throws: a corrupted settings file yields the default schedule.
 */
function normalizeSchedule(input) {
	const raw = input && typeof input === "object" ? input : {};
	const mode = SCHEDULE_MODES.includes(raw.mode) ? raw.mode : "interval";
	const order = ORDER_MODES.includes(raw.order) ? raw.order : "sequential";
	const intervalMin = Number.isFinite(Number(raw.intervalMin))
		? clamp(Math.round(Number(raw.intervalMin)), INTERVAL_MIN, INTERVAL_MAX)
		: 30;
	const transitionMs = Number.isFinite(Number(raw.transitionMs))
		? clamp(Math.round(Number(raw.transitionMs)), TRANSITION_MIN, TRANSITION_MAX)
		: 1200;
	// Canonicalised, not merely validated: `9:5` is accepted as *input* (a hand
	// edited file, or a browser that reports it that way) but stored as `09:05`,
	// so every reader — including an `<input type="time">` — sees one format.
	const parsedClock = parseClock(raw.atTime);
	const clock = parsedClock === null ? "07:30" : formatClock(parsedClock);
	return {
		mode,
		order,
		intervalMin,
		atMinutes: normalizeHourlyMinutes(raw.atMinutes),
		atTime: clock,
		transitionMs,
		anchorAt: Number.isFinite(Number(raw.anchorAt)) && Number(raw.anchorAt) > 0 ? Number(raw.anchorAt) : 0
	};
}

/**
 * The next time the wallpaper should change, strictly after `now`.
 *
 * @param {object} schedule normalized schedule (see {@link normalizeSchedule})
 * @param {number} now epoch ms
 * @returns {number} epoch ms, or 0 when the mode is not clock-driven (`session`)
 */
function nextTriggerAt(schedule, now) {
	const s = normalizeSchedule(schedule);
	if (s.mode === "session") return 0;
	if (s.mode === "interval") {
		const step = s.intervalMin * MINUTE;
		const anchor = s.anchorAt > 0 ? s.anchorAt : now;
		if (now < anchor) return anchor;
		// Grid-aligned rather than now+N: see the module note. Floor + 1 keeps the
		// result strictly in the future, which is what the caller's "am I due?"
		// test assumes.
		return anchor + (Math.floor((now - anchor) / step) + 1) * step;
	}
	if (s.mode === "hourly") {
		const base = startOfHour(now);
		for (const minute of s.atMinutes) {
			const candidate = base + minute * MINUTE;
			if (candidate > now) return candidate;
		}
		return base + HOUR + s.atMinutes[0] * MINUTE;
	}
	// daily
	const minutes = parseClock(s.atTime);
	const today = startOfDay(now) + minutes * MINUTE;
	if (today > now) return today;
	const d = new Date(now);
	// Rebuild from calendar fields rather than +24h so a DST shift keeps the
	// change at the same wall-clock time, which is the whole point of `daily`.
	const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, Math.floor(minutes / 60), minutes % 60, 0, 0);
	return tomorrow.getTime();
}

/**
 * The next `count` trigger times, for the panel's "接下来" preview.
 * Always ascending, always strictly in the future.
 */
function upcomingTriggers(schedule, now, count) {
	const s = normalizeSchedule(schedule);
	if (s.mode === "session") return [];
	const out = [];
	let cursor = now;
	for (let i = 0; i < Math.max(0, count); i += 1) {
		const next = nextTriggerAt(s, cursor);
		if (next <= cursor) break;
		out.push(next);
		cursor = next;
	}
	return out;
}

/**
 * Whether the trigger is due, and the schedule to carry forward afterwards.
 *
 * Called on boot and on every wake-up. `missed` counts how many triggers were
 * skipped (the panel reports it so a user who closed the laptop for a week
 * sees why the picture only changed once); it is informational — the plan
 * always advances by exactly one.
 *
 * @returns {{due: boolean, missed: number, nextAt: number}}
 */
function planResume(schedule, now, persistedNextAt) {
	const s = normalizeSchedule(schedule);
	if (s.mode === "session") return { due: false, missed: 0, nextAt: 0 };
	const nextAt = nextTriggerAt(s, now);
	if (!Number.isFinite(persistedNextAt) || persistedNextAt <= 0) {
		return { due: false, missed: 0, nextAt };
	}
	if (persistedNextAt > now) {
		// Not yet due — keep the persisted instant so a reload cannot postpone it.
		return { due: false, missed: 0, nextAt: persistedNextAt };
	}
	const step = s.mode === "interval" ? s.intervalMin * MINUTE : 0;
	const missed = step > 0 ? Math.max(1, Math.floor((now - persistedNextAt) / step) + 1) : 1;
	return { due: true, missed, nextAt };
}

/** Indices 0..length-1 as an array. */
function range(length) {
	return Array.from({ length: Math.max(0, length) }, (_, i) => i);
}

/**
 * Advance the playlist cursor by one step, honouring the order mode.
 *
 * `shuffle` carries a `remaining` queue. A queue rather than "pick a random
 * index and hope": with a uniform draw, a three-item playlist repeats the same
 * picture about a third of the time, which users read as "the rotation is
 * broken". The queue guarantees every entry is shown once before any repeats.
 *
 * WHY IT MINTS ITS OWN STREAM FROM `orderStep`. The obvious implementation
 * takes an rng argument and lets the caller pass a fresh one — which is exactly
 * what makes `random` order collapse: a fresh mulberry32 returns the *same*
 * first draw every time, so every step picks the same index and the rotation
 * looks frozen (measured: `random` degenerated to a 1,0,1,0 alternation over a
 * five-entry list). Carrying a monotonic step counter in the cursor state and
 * seeding from it keeps the draw varied, keeps it reproducible after a reload,
 * and keeps the whole thing a pure function of the state it is handed.
 *
 * The return value is the *whole* cursor state with `cursor`/`remaining`
 * replaced, not just those two fields — a partial result invites the caller to
 * feed it back in and silently lose `length` and `order`.
 *
 * @param {{cursor: number, length: number, order: string, remaining?: number[], orderStep?: number}} state
 */
function stepCursor(state) {
	const length = Math.max(0, Math.floor(state.length || 0));
	const order = ORDER_MODES.includes(state.order) ? state.order : "sequential";
	const orderStep = Math.max(0, Math.floor(state.orderStep || 0));
	const nextStep = orderStep + 1;
	if (length === 0) return { ...state, cursor: 0, remaining: [], orderStep: nextStep };
	if (length === 1) return { ...state, cursor: 0, remaining: [], orderStep: nextStep };
	const cursor = clamp(Math.floor(state.cursor || 0), 0, length - 1);
	const rng = orderRng(orderStep);

	if (order === "random") {
		let next = rng.int(0, length - 1);
		if (next === cursor) {
			// Nudge off the current index so an unlucky draw cannot look like a
			// frozen rotation. Uniform over the other length-1 slots.
			next = (cursor + 1 + rng.int(0, length - 2)) % length;
		}
		return { ...state, cursor: next, remaining: [], orderStep: nextStep };
	}
	if (order === "shuffle") {
		let remaining = Array.isArray(state.remaining) ? state.remaining.filter((i) => Number.isInteger(i) && i >= 0 && i < length) : [];
		if (remaining.length === 0) {
			remaining = shuffled(range(length).filter((i) => i !== cursor), rng);
			// A single-item remainder after the filter (length === 2) is correct:
			// there genuinely is only one other entry to show.
			if (remaining.length === 0) remaining = range(length);
		}
		const next = remaining[0];
		return { ...state, cursor: next, remaining: remaining.slice(1), orderStep: nextStep };
	}
	return { ...state, cursor: (cursor + 1) % length, remaining: [], orderStep: nextStep };
}

/**
 * A new cursor after the playlist itself changed (an entry added, removed or
 * reordered). Keeping the *item* selected matters more than keeping the
 * *index*: removing entry 0 should not silently swap the wallpaper.
 */
function reconcileCursor(previousCursor, previousLength, nextLength, cursorItemIndex) {
	const length = Math.max(0, Math.floor(nextLength || 0));
	if (length === 0) return { cursor: 0, remaining: [] };
	if (Number.isInteger(cursorItemIndex) && cursorItemIndex >= 0 && cursorItemIndex < length) {
		return { cursor: cursorItemIndex, remaining: [] };
	}
	if (previousLength <= 0) return { cursor: 0, remaining: [] };
	const approximate = Math.round((previousCursor / previousLength) * length);
	return { cursor: clamp(approximate, 0, length - 1), remaining: [] };
}

/** A seeded stream for one order decision, derived from the cursor's step. */
function orderRng(orderStep) {
	return createRng(`lumen-order:${Math.max(0, Math.floor(orderStep || 0))}`);
}

module.exports = {
	SCHEDULE_MODES,
	ORDER_MODES,
	INTERVAL_MIN,
	INTERVAL_MAX,
	TRANSITION_MIN,
	TRANSITION_MAX,
	normalizeSchedule,
	nextTriggerAt,
	upcomingTriggers,
	planResume,
	stepCursor,
	reconcileCursor,
	orderRng,
	parseClock,
	formatClock,
	normalizeHourlyMinutes,
	range
};
