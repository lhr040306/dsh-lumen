"use strict";
/**
 * The packaged clip itself, checked against the three constraints in
 * `docs/SPLASH-SPEC.md` §9.6.
 *
 * Those three are not style preferences — each one is a cost paid on the boot
 * path, which is exactly the moment the splash exists to cover:
 *
 *   - `moov` before `mdat` (faststart), or the browser needs a second round
 *     trip to the end of the file before it knows the duration and index;
 *   - no audio track, or the element (which is muted) still demuxes it and
 *     spins up an audio decoder for sound nobody will hear;
 *   - one resolution step below the display size, or the decode work grows
 *     faster than the picture improves — 1680×960 in a 1280-wide cover is 44%
 *     more pixels for no visible gain, and 3.5× the bytes.
 *
 * Until this file existed, "换素材时必须一起满足" was enforced by whoever did
 * the swap remembering to re-encode. That is the same class of guarantee as a
 * comment. A hand-written box walker is enough here: the checks are about
 * structure, not about decoding, so nothing needs a codec or a child process.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLIP = path.join(__dirname, "..", "media", "splash.mp4");

/** Bytes of a box's header, given its 32-bit size field. */
const headerOf = (size) => (size === 1 ? 16 : 8);

/** One box starting at `offset`, clipped to `end`. */
function boxAt(buf, offset, end) {
	const size = buf.readUInt32BE(offset);
	const type = buf.toString("latin1", offset + 4, offset + 8);
	const header = headerOf(size);
	const declared = size === 1 ? Number(buf.readBigUInt64BE(offset + 8)) : size === 0 ? end - offset : size;
	return { type, start: offset, body: offset + header, end: Math.min(offset + declared, end), size: declared };
}

/** The boxes that tile `[start, end)`. Stops rather than throwing on a truncated tail. */
function children(buf, start, end) {
	const out = [];
	let offset = start;
	while (offset + 8 <= end) {
		const box = boxAt(buf, offset, end);
		if (box.size < 8) break;
		out.push(box);
		offset = box.end;
	}
	return out;
}

const find = (boxes, type) => boxes.find((box) => box.type === type);

/** Every `trak` in `moov`, with the handler, timescale and sample entry that matter here. */
function tracks(buf, moov) {
	const out = [];
	for (const trak of children(buf, moov.body, moov.end)) {
		if (trak.type !== "trak") continue;
		const track = { handler: null, sampleEntry: null, width: 0, height: 0, sar: "1:1", duration: 0 };
		for (const mdia of children(buf, trak.body, trak.end)) {
			if (mdia.type !== "mdia") continue;
			for (const inner of children(buf, mdia.body, mdia.end)) {
				if (inner.type === "hdlr") track.handler = buf.toString("latin1", inner.body + 8, inner.body + 12);
				if (inner.type === "mdhd") {
					const version = buf[inner.body];
					const timescale = buf.readUInt32BE(inner.body + (version ? 20 : 12));
					const duration = version
						? Number(buf.readBigUInt64BE(inner.body + 24))
						: buf.readUInt32BE(inner.body + 16);
					track.duration = timescale ? duration / timescale : 0;
				}
				if (inner.type !== "minf") continue;
				for (const minf of children(buf, inner.body, inner.end)) {
					if (minf.type !== "stbl") continue;
					const stsd = find(children(buf, minf.body, minf.end), "stsd");
					if (!stsd) continue;
					// `stsd` is a full box: 4 bytes of version + flags, 4 of entry count.
					const [entry] = children(buf, stsd.body + 8, stsd.end);
					if (!entry) continue;
					track.sampleEntry = entry.type;
					// Visual sample entries put width/height 24 bytes into their own body.
					track.width = buf.readUInt16BE(entry.body + 24);
					track.height = buf.readUInt16BE(entry.body + 26);
					for (const extra of children(buf, entry.body + 78, entry.end)) {
						if (extra.type !== "pasp") continue;
						track.sar = `${buf.readUInt32BE(extra.body)}:${buf.readUInt32BE(extra.body + 4)}`;
					}
				}
			}
		}
		out.push(track);
	}
	return out;
}

/** The whole file, read once — it is under a megabyte and every assertion wants it. */
function readClip() {
	const buf = fs.readFileSync(CLIP);
	const top = children(buf, 0, buf.length);
	const moov = find(top, "moov");
	assert.ok(moov, "the clip has no moov box at all");
	return { buf, top, moov, tracks: tracks(buf, moov) };
}

test("the packaged clip is faststart: moov comes before mdat", () => {
	const { top } = readClip();
	const moov = find(top, "moov");
	const mdat = find(top, "mdat");
	assert.ok(mdat, "the clip has no mdat box");
	assert.ok(
		moov.start < mdat.start,
		`moov sits at ${moov.start} and mdat at ${mdat.start} — the browser would have to fetch the tail before it can start`
	);
});

test("the packaged clip carries exactly one video track and no audio", () => {
	const { tracks: list } = readClip();
	assert.equal(list.length, 1, `expected one track, found ${list.length}: ${list.map((t) => t.handler).join(", ")}`);
	assert.equal(list[0].handler, "vide", "the only track is not video");
	assert.equal(list[0].sampleEntry, "avc1", "the video track is not H.264 — this build's player is the reason it is");
});

test("the packaged clip is one resolution step below the display size, with square pixels", () => {
	const { tracks: list } = readClip();
	const [video] = list;
	assert.equal(`${video.width}x${video.height}`, "1260x720", "the clip is not at the documented 1260×720");
	assert.equal(video.sar, "1:1", `non-square pixels (SAR ${video.sar}) cost the player a rescale it should not pay`);
});

test("the packaged clip stays inside the size and duration budget it documents", () => {
	const { buf, tracks: list } = readClip();
	const [video] = list;
	assert.ok(buf.length <= 1024 * 1024, `${(buf.length / 1024).toFixed(0)} KB is over the 1 MB budget for a bundled clip`);
	assert.ok(video.duration > 0 && video.duration <= 8, `${video.duration}s is outside the 8s band the cover's own timing assumes`);
});
