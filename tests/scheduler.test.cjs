"use strict";
/**
 * The rotation scheduler.
 *
 * Every one of these is an edge case that is impractical to test through a
 * browser timer and trivial to test as a pure function — which is the argument
 * for the scheduler being a pure module in the first place.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	SCHEDULE_MODES,
	ORDER_MODES,
	normalizeSchedule,
	nextTriggerAt,
	upcomingTriggers,
	planResume,
	stepCursor,
	reconcileCursor,
	orderRng,
	parseClock,
	formatClock,
	normalizeHourlyMinutes
} = require("../src/scheduler.cjs");

const MINUTE = 60000;
const HOUR = 60 * MINUTE;

/** A local-time timestamp, so expectations do not depend on the machine's zone. */
function at(year, month, day, hour, minute) {
	return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const clockOf = (ts) => {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("normalizeSchedule repairs anything into a runnable schedule", () => {
	const fallback = normalizeSchedule(null);
	assert.equal(fallback.mode, "interval");
	assert.equal(fallback.order, "sequential");
	assert.equal(fallback.intervalMin, 30);
	assert.deepEqual(fallback.atMinutes, [0]);
	assert.equal(fallback.atTime, "07:30");
	assert.equal(fallback.anchorAt, 0);

	assert.equal(normalizeSchedule({ mode: "nonsense" }).mode, "interval");
	assert.equal(normalizeSchedule({ intervalMin: 1 }).intervalMin, 5, "below the floor");
	assert.equal(normalizeSchedule({ intervalMin: 1e9 }).intervalMin, 60 * 24 * 30, "above the ceiling");
	assert.equal(normalizeSchedule({ transitionMs: -50 }).transitionMs, 0);
	assert.equal(normalizeSchedule({ transitionMs: 1e6 }).transitionMs, 4000);
	assert.equal(normalizeSchedule({ atTime: "25:00" }).atTime, "07:30");
	assert.equal(normalizeSchedule({ atTime: "9:5" }).atTime, "09:05", "a loose value is canonicalised, not rejected");
	assert.equal(normalizeSchedule({ atTime: "7:30" }).atTime, "07:30");
	// Out-of-range minutes are dropped, duplicates collapsed, survivors sorted.
	assert.deepEqual(normalizeSchedule({ atMinutes: [7, 3, 7, 99, -1] }).atMinutes, [3, 7]);
	assert.deepEqual(normalizeSchedule({ atMinutes: [] }).atMinutes, [0]);
});

test("parseClock and formatClock round-trip and refuse rubbish", () => {
	assert.equal(parseClock("07:30"), 450);
	assert.equal(parseClock("00:00"), 0);
	assert.equal(parseClock("23:59"), 1439);
	assert.equal(parseClock("24:00"), null);
	assert.equal(parseClock("12:60"), null);
	assert.equal(parseClock("7:3"), 423, "single-digit fields are still numbers");
	assert.equal(parseClock("07-30"), null);
	assert.equal(parseClock(null), null);
	assert.equal(formatClock(450), "07:30");
	assert.equal(formatClock(0), "00:00");
	assert.equal(formatClock(1440), "00:00", "a full day wraps");
});

test("every declared mode is handled by nextTriggerAt", () => {
	for (const mode of SCHEDULE_MODES) {
		const now = at(2026, 5, 4, 10, 17);
		const next = nextTriggerAt(normalizeSchedule({ mode }), now);
		if (mode === "session") {
			assert.equal(next, 0, "session is not clock-driven");
		} else {
			assert.ok(next > now, `${mode} did not move forward`);
			assert.ok(Number.isFinite(next));
		}
	}
});

test("interval is grid-aligned to its anchor, not to the last change", () => {
	const anchor = at(2026, 5, 4, 10, 0);
	const schedule = normalizeSchedule({ mode: "interval", intervalMin: 30, anchorAt: anchor });
	// Ten past: the next boundary is half past, not ten-to-eleven.
	assert.equal(nextTriggerAt(schedule, at(2026, 5, 4, 10, 10)), at(2026, 5, 4, 10, 30));
	// Exactly on a boundary: the answer is the NEXT one, strictly in the future.
	assert.equal(nextTriggerAt(schedule, at(2026, 5, 4, 10, 30)), at(2026, 5, 4, 11, 0));
	// A time before the anchor falls back to the anchor itself.
	assert.equal(nextTriggerAt(schedule, at(2026, 5, 4, 9, 0)), anchor);
	// Asking repeatedly inside one window gives the same answer: a reload cannot
	// push the change out of reach, which is the bug this design exists to avoid.
	const first = nextTriggerAt(schedule, at(2026, 5, 4, 10, 1));
	const second = nextTriggerAt(schedule, at(2026, 5, 4, 10, 29));
	assert.equal(first, second);
});

test("an unanchored interval schedules one step ahead", () => {
	const now = at(2026, 5, 4, 10, 17);
	const schedule = normalizeSchedule({ mode: "interval", intervalMin: 15 });
	assert.equal(nextTriggerAt(schedule, now), now + 15 * MINUTE);
});

test("hourly lands on the next chosen minute, wrapping the hour", () => {
	const schedule = normalizeSchedule({ mode: "hourly", atMinutes: [0, 30] });
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 10, 5))), "10:30");
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 10, 45))), "11:00", "wrapped past the last minute");
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 10, 30))), "11:00", "exactly on a minute goes to the next");
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 23, 45))), "00:00", "crossed midnight");
});

test("hourly minutes are de-duplicated, sorted, and out-of-range values dropped", () => {
	assert.deepEqual(normalizeHourlyMinutes([30, 0, 30, 15]), [0, 15, 30]);
	// Dropped, not clamped: clamping would invent a :59 trigger the user never
	// asked for, and it would then be listed in "upcoming" as if it were intended.
	assert.deepEqual(normalizeHourlyMinutes([30, 99, -4]), [30]);
	assert.deepEqual(normalizeHourlyMinutes([12.7]), [13]);
	assert.deepEqual(normalizeHourlyMinutes([]), [0]);
	assert.deepEqual(normalizeHourlyMinutes("nope"), [0]);
	assert.deepEqual(normalizeHourlyMinutes([NaN, "x", null]), [0]);
});

test("daily fires at its wall-clock time today or tomorrow", () => {
	const schedule = normalizeSchedule({ mode: "daily", atTime: "07:30" });
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 6, 0))), "07:30", "later today");
	assert.equal(clockOf(nextTriggerAt(schedule, at(2026, 5, 4, 6, 0))), "07:30");
	const afterToday = nextTriggerAt(schedule, at(2026, 5, 4, 8, 0));
	assert.equal(clockOf(afterToday), "07:30", "already passed, so tomorrow still reads 07:30");
	assert.equal(new Date(afterToday).getDate(), 5, "and it is the next calendar day");
});

test("daily rebuilds from calendar fields, so a DST shift keeps the wall clock", () => {
	// The implementation must not be `+24h`; this asserts the *observed* wall
	// clock across a fortnight rather than a fixed offset.
	const schedule = normalizeSchedule({ mode: "daily", atTime: "07:30" });
	let cursor = at(2026, 3, 1, 12, 0);
	for (let day = 0; day < 14; day += 1) {
		const next = nextTriggerAt(schedule, cursor);
		assert.equal(clockOf(next), "07:30", `day ${day} drifted`);
		cursor = next;
	}
});

test("session mode has no clock and yields no upcoming list", () => {
	const schedule = normalizeSchedule({ mode: "session" });
	assert.equal(nextTriggerAt(schedule, at(2026, 5, 4, 10, 0)), 0);
	assert.deepEqual(upcomingTriggers(schedule, at(2026, 5, 4, 10, 0), 3), []);
});

test("upcoming triggers are ascending, strictly future, and respect the count", () => {
	for (const shape of [
		{ mode: "interval", intervalMin: 20 },
		{ mode: "hourly", atMinutes: [0, 20, 40] },
		{ mode: "daily", atTime: "09:00" }
	]) {
		const now = at(2026, 5, 4, 10, 7);
		const list = upcomingTriggers(normalizeSchedule(shape), now, 4);
		assert.equal(list.length, 4);
		assert.ok(list[0] > now, `${shape.mode} produced a past first trigger`);
		for (let i = 1; i < list.length; i += 1) {
			assert.ok(list[i] > list[i - 1], `${shape.mode} is not ascending`);
		}
	}
	assert.deepEqual(upcomingTriggers(normalizeSchedule({ mode: "interval" }), Date.now(), 0), []);
});

test("planResume does not fire early, and keeps the persisted instant", () => {
	const schedule = normalizeSchedule({ mode: "interval", intervalMin: 30 });
	const now = at(2026, 5, 4, 10, 10);
	const future = now + 12 * MINUTE;
	const plan = planResume(schedule, now, future);
	assert.equal(plan.due, false);
	assert.equal(plan.nextAt, future, "a reload must not postpone the change");
});

test("planResume fires once after a long sleep and reports how much was missed", () => {
	const schedule = normalizeSchedule({ mode: "interval", intervalMin: 30 });
	const now = at(2026, 5, 4, 10, 0);
	const plan = planResume(schedule, now, now - 95 * MINUTE);
	assert.equal(plan.due, true);
	assert.equal(plan.missed, 4, "95 minutes of a 30-minute grid is 4 boundaries");
	assert.ok(plan.nextAt > now, "the schedule must be re-armed into the future");
});

test("planResume on a first run just arms the schedule", () => {
	const plan = planResume(normalizeSchedule({ mode: "hourly" }), at(2026, 5, 4, 10, 0), 0);
	assert.equal(plan.due, false);
	assert.equal(plan.missed, 0);
	assert.ok(plan.nextAt > at(2026, 5, 4, 10, 0));
});

test("session mode never reports due, whatever the persisted value", () => {
	const plan = planResume(normalizeSchedule({ mode: "session" }), Date.now(), 1);
	assert.deepEqual(plan, { due: false, missed: 0, nextAt: 0 });
});

test("sequential order is a plain cycle", () => {
	let cursor = { cursor: 0, length: 4, order: "sequential", remaining: [], orderStep: 0 };
	const seen = [];
	for (let i = 0; i < 9; i += 1) {
		cursor = stepCursor(cursor);
		seen.push(cursor.cursor);
	}
	assert.deepEqual(seen, [1, 2, 3, 0, 1, 2, 3, 0, 1]);
});

test("shuffle shows every other entry before repeating any", () => {
	const length = 5;
	let cursor = { cursor: 0, length, order: "shuffle", remaining: [], orderStep: 0 };
	const seen = [];
	for (let i = 0; i < length * 6; i += 1) {
		cursor = stepCursor(cursor);
		seen.push(cursor.cursor);
	}
	// No entry may equal the one immediately before it.
	for (let i = 1; i < seen.length; i += 1) {
		assert.notEqual(seen[i], seen[i - 1], `repeated at index ${i}: ${seen.join(",")}`);
	}
	// Every block of `length - 1` steps must cover all the *other* entries.
	for (let start = 0; start < seen.length - (length - 1); start += length - 1) {
		const block = seen.slice(start, start + (length - 1));
		assert.equal(new Set(block).size, length - 1, `block ${start} repeated an entry: ${block.join(",")}`);
	}
});

test("shuffle works for a two-entry playlist, where the only move is the other one", () => {
	let cursor = { cursor: 0, length: 2, order: "shuffle", remaining: [], orderStep: 0 };
	const seen = [];
	for (let i = 0; i < 6; i += 1) {
		cursor = stepCursor(cursor);
		seen.push(cursor.cursor);
	}
	assert.deepEqual(seen, [1, 0, 1, 0, 1, 0]);
});

test("random order never repeats the previous entry but does vary", () => {
	let cursor = { cursor: 0, length: 6, order: "random", remaining: [], orderStep: 0 };
	const seen = [];
	for (let i = 0; i < 40; i += 1) {
		cursor = stepCursor(cursor);
		seen.push(cursor.cursor);
	}
	for (let i = 1; i < seen.length; i += 1) assert.notEqual(seen[i], seen[i - 1]);
	// The bug this guards: seeding a fresh stream per step made every draw
	// identical and collapsed the rotation to a two-cycle.
	assert.ok(new Set(seen).size >= 5, `random only ever produced ${new Set(seen).size} entries`);
});

test("a step result is a complete cursor state", () => {
	// Feeding a partial result back in is the natural thing for a caller to do,
	// and it must not lose `length`/`order`.
	let cursor = { cursor: 0, length: 3, order: "shuffle", remaining: [], orderStep: 0 };
	for (let i = 0; i < 10; i += 1) {
		cursor = stepCursor(cursor);
		assert.equal(cursor.length, 3, "length was dropped");
		assert.equal(cursor.order, "shuffle", "order was dropped");
		assert.equal(typeof cursor.orderStep, "number", "orderStep was dropped");
	}
});

test("degenerate playlists never throw or advance", () => {
	assert.deepEqual(stepCursor({ cursor: 0, length: 0, order: "sequential" }).cursor, 0);
	assert.equal(stepCursor({ cursor: 0, length: 1, order: "shuffle" }).cursor, 0);
	assert.equal(stepCursor({ cursor: 99, length: 3, order: "sequential" }).cursor, 0, "an out-of-range cursor clamps before advancing");
	// Corrupt shuffle queues are discarded rather than trusted.
	const repaired = stepCursor({ cursor: 1, length: 3, order: "shuffle", remaining: [99, -1, "x"] });
	assert.ok(repaired.cursor >= 0 && repaired.cursor < 3);
});

test("every declared order mode is exercised", () => {
	for (const order of ORDER_MODES) {
		const next = stepCursor({ cursor: 0, length: 4, order, remaining: [], orderStep: 1 });
		assert.ok(Number.isInteger(next.cursor) && next.cursor >= 0 && next.cursor < 4, `${order} produced ${next.cursor}`);
	}
});

test("orderRng is reproducible from its step and varies by step", () => {
	assert.equal(orderRng(5).int(0, 1e9), orderRng(5).int(0, 1e9));
	assert.notEqual(orderRng(5).int(0, 1e9), orderRng(6).int(0, 1e9));
});

test("reconcileCursor keeps the selected item when the playlist shifts", () => {
	// The item that was at index 2 is now at index 1 (entry 0 was removed).
	const afterRemoval = reconcileCursor(2, 4, 3, 1);
	assert.equal(afterRemoval.cursor, 1);
	// Nothing to preserve: fall back to the proportional position.
	const proportional = reconcileCursor(2, 4, 3, null);
	assert.equal(proportional.cursor, 2);
	assert.equal(reconcileCursor(0, 4, 0, null).cursor, 0);
	assert.equal(reconcileCursor(0, 0, 5, 3).cursor, 3);
});
