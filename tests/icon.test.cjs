"use strict";
/**
 * The plugin icon, kept inside the host's metadata budget.
 *
 * The host reads `package.json` and refuses the whole plugin entry with
 * "Plugin metadata for dsh-lumen: Error: …/package.json:icon exceeds 256 KiB"
 * when the file is heavier than that. It is not a warning and it is not
 * recoverable in the UI: the plugin still runs, the card just shows a red
 * error line instead of an icon, which is exactly what shipped in 1.3.2 — a
 * 512px PNG at 351 KiB, produced by a script that had no reason to know the
 * limit existed.
 *
 * So the limit belongs in a test, not in the head of whoever re-exports the
 * icon next time. The three checks below are the whole contract we depend on:
 * the field points at a file that exists, that file is a PNG the host can
 * hand to an `<img>`, and it is light enough to pass the metadata gate. The
 * square assertion is ours rather than the host's — every slot we render into
 * is square, so a non-square file would silently letterbox.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ICON = path.join(ROOT, PKG.icon);

/** Host limit for `package.json` `icon`, in bytes. */
const BUDGET = 256 * 1024;

test("the icon field points at a file that ships", () => {
	assert.ok(fs.existsSync(ICON), `${PKG.icon} is declared but missing`);

	// `files` decides what npm pack puts in the tarball; an icon outside it
	// installs fine from a git checkout and is absent from every packed build.
	const listed = (PKG.files || []).some((entry) => PKG.icon.replace(/^\.\//, "").startsWith(entry));
	assert.ok(listed, `${PKG.icon} is not covered by package.json "files"`);
});

test("the icon is a square PNG inside the host's 256 KiB metadata budget", () => {
	const bytes = fs.statSync(ICON).size;
	assert.ok(bytes <= BUDGET, `icon is ${bytes} bytes, ${bytes - BUDGET} over the ${BUDGET}-byte limit`);

	const head = fs.readFileSync(ICON).subarray(0, 24);
	assert.deepEqual(
		[...head.subarray(0, 8)],
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		"icon is not a PNG",
	);
	// IHDR is the first chunk: width and height sit at byte 16 and 20.
	const width = head.readUInt32BE(16);
	const height = head.readUInt32BE(20);
	assert.equal(width, height, `icon is ${width}×${height}, expected square`);
	assert.ok(width >= 128, `icon is only ${width}px — a 128px slot on a 2x display would upscale`);
});
