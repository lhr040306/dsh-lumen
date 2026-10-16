/**
 * dsh-lumen — host half.
 *
 * Durable, origin-independent persistence for the browser half, plus the splash
 * media store and the boot cover.
 *
 * WHY THIS HALF EXISTS AT ALL
 *
 * DSH Desktop binds its web server to an OS-assigned port on every launch, so
 * the page's origin changes on every restart. `localStorage` is scoped per
 * origin, which means a purely client-side plugin "forgets" the user's
 * wallpaper every time the app is reopened — the bytes are still in the
 * browser's leveldb, just filed under the previous port. Preferences that
 * survive a restart therefore need a store the *host* owns, and this half
 * provides it:
 *
 *   - a state file at `$DSH_HOME/lumen.json` (default `~/.dsh/lumen.json`),
 *     written atomically via tmp + rename, holding a FLAT map of string values.
 *
 *     Flat, and string-valued, on purpose. The file is shared by every process
 *     resolving to the same DSH_HOME — the web profile and the desktop shell can
 *     both be running, possibly at different plugin versions. A nested document
 *     would be read by an older build as `"[object Object]"` and written back as
 *     a preference. A flat string map degrades to "an unknown key we ignore".
 *     Image payloads are therefore their own keys, not a nested field.
 *
 *   - a fenced JSON API at `/lumen/api`. `get` returns the state without the
 *     reserved key; `set` MERGES a patch, where a string sets a key and `null`
 *     removes it, and keys absent from the patch are left alone. The client
 *     relies on that: two tabs (or the web shell and a desktop window) each hold
 *     their own copy, and a merge means the one that changed the wash cannot
 *     wipe the wallpaper the other just set.
 *
 *   - a size ceiling on the whole file. Every write is checked against it before
 *     it lands, so a client bug that keeps appending blob keys fails loudly on
 *     that one write instead of filling the user's home directory.
 *
 * ROUTE SECURITY is a trust fence, not authentication, and it runs in a fixed
 * order — see {@link fenceRejection}. Layer one is this plugin's own Host/Origin
 * validator, which stands on its own on every build. Layer two is the host's
 * `connection.requestRejection`, which adds the browser-session check a plugin
 * route cannot reach by itself. Layer three is the fallback: when a build does
 * not carry that service, layer one stands alone and says so once, at load, so
 * the missing layer is never invisible from the outside. It is a DNS-rebinding
 * and cross-site defence first, and is written down here so nobody mistakes it
 * for access control.
 *
 * WHY THE SPLASH STORES A FILE NAME AND NOT A PATH
 *
 * A splash is one to two orders of magnitude larger than a wallpaper: a
 * generated wallpaper is a few hundred bytes of gradient, a 20-second clip is
 * two megabytes. The state document is a flat string map with a 24 MiB ceiling,
 * shared by every process on this DSH_HOME, so media bytes and media *paths*
 * both stay out of it. The bytes live in `$DSH_HOME/lumen-media/` under a name
 * this file generates, and the state holds only that name — which also means
 * the served path is built from a allowlisted shape rather than from anything a
 * request supplied. See {@link SPLASH_KEY}.
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync, readdirSync, createReadStream, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";

/** State file name inside the DSH home directory. */
const STATE_FILENAME = "lumen.json";
/**
 * Reserved key holding the file's schema version as a decimal string.
 *
 * Deliberately absent from every `get` answer — the browser must never adopt it
 * as a preference — and re-derived from the file itself on every write, so a
 * patch that tries to stamp a version cannot.
 */
export const STATE_SCHEMA_KEY = "dsh-lumen:schema-version";
/** Schema version this build writes and understands. Bump only with a migration. */
export const STATE_SCHEMA_VERSION = "1";
// Fail at import rather than write a "NaN" stamp onto the user's file.
if (!/^\d+$/.test(STATE_SCHEMA_VERSION) || Number(STATE_SCHEMA_VERSION) < 1) {
	throw new Error(`dsh-lumen: STATE_SCHEMA_VERSION must be a decimal integer string >= 1, got ${JSON.stringify(STATE_SCHEMA_VERSION)}`);
}
/** Max accepted request body, bytes. Wallpaper data URLs are the biggest payload. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
/**
 * Max size of the persisted file, bytes. Enforced on the *serialised* document,
 * so the limit is what actually lands on disk.
 */
const MAX_STATE_BYTES = 24 * 1024 * 1024;
/** Max number of keys the file may hold, so a runaway client cannot grow it without bound. */
const MAX_STATE_KEYS = 64;
/** Route prefix owned by this plugin. */
const API_PREFIX = "/lumen/api";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-lumen";
/**
 * Services required before mounting.
 *
 * `connection` is deliberately NOT in this list. It is the host's own gate and
 * the fence below prefers it, but a build without it must still mount: every
 * feature this plugin exists for works under its own validator, and refusing to
 * load over a missing *extra* defence would turn a hardening into an outage.
 * The service is therefore probed, not demanded — the same reason it is read
 * through `Reflect.get` here rather than imported as a type.
 */
export const inject = ["webServer", "webRuntime"];

// ── state file ─────────────────────────────────────────────────────────────

/** DSH home directory, honouring the environment override. */
function dshHome() {
	return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
}

/** Absolute path of the state file under the DSH home directory. */
function documentPath() {
	return join(dshHome(), STATE_FILENAME);
}

/**
 * Read the file as a plain object, metadata key included.
 * `{}` when absent, unparsable or not an object — a corrupt file is treated as
 * empty, which is how this plugin behaves everywhere: the browser half still
 * holds the seed values and pushes them back.
 */
function readDocument() {
	try {
		const parsed = JSON.parse(readFileSync(documentPath(), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The state object as the browser sees it: everything except the stamp. */
function readPreferences() {
	const state = readDocument();
	delete state[STATE_SCHEMA_KEY];
	return state;
}

/** Current size of the file on disk, or 0 when it does not exist yet. */
function documentBytes() {
	try {
		return statSync(documentPath()).size;
	} catch {
		return 0;
	}
}

/** The stamped version when the file carries a decimal integer string, else 0. */
function observedSchemaVersion(raw) {
	const stamp = raw[STATE_SCHEMA_KEY];
	if (typeof stamp !== "string" || !/^\d+$/.test(stamp)) return 0;
	return Number(stamp);
}

/**
 * The stamp to write: ours, or the one already on the file when that is HIGHER.
 *
 * A newer build may have put keys in this file that we pass through untouched.
 * Stamping our own version onto those bytes would claim a format the file is
 * not, and the next upgrade would run its migration over data that already went
 * through one. Nothing we write removes unknown keys, so the highest stamp any
 * writer has declared stays true.
 */
function schemaStampFor(raw) {
	const ours = Number(STATE_SCHEMA_VERSION);
	const seen = observedSchemaVersion(raw);
	return String(seen > ours ? seen : ours);
}

/** Outcome of a write attempt. */
function writePreferences(state) {
	const existing = readDocument();
	const body = JSON.stringify({ ...state, [STATE_SCHEMA_KEY]: schemaStampFor(existing) });
	if (Buffer.byteLength(body, "utf8") > MAX_STATE_BYTES) return { ok: false, reason: "state-too-large" };
	const keys = Object.keys(state).length + 1;
	if (keys > MAX_STATE_KEYS) return { ok: false, reason: "too-many-keys" };
	const file = documentPath();
	try {
		mkdirSync(dirname(file), { recursive: true });
	} catch {
		return { ok: false, reason: "mkdir-failed" };
	}
	const tmp = `${file}.tmp`;
	try {
		// The file holds the user's own wallpaper images, so keep it owner-only on
		// POSIX. The mode is ignored on Windows, where the profile directory ACL
		// already restricts access.
		writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
		try {
			renameSync(tmp, file);
		} catch {
			// rename can fail on Windows if the target is transiently locked by
			// another process; this single-writer fallback is safe here.
			writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
		}
		// Our own write is the one cache invalidation this process can know about
		// exactly; see {@link splashNameForCover} for why that covers the rest.
		coverCache = null;
		return { ok: true, bytes: Buffer.byteLength(body, "utf8") };
	} catch (error) {
		return { ok: false, reason: "write-failed", message: error && error.message };
	}
}

// ── trust fence ────────────────────────────────────────────────────────────

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * Assert one configured `trustedHosts` entry is a bare authority (`host` or
 * `host:port`) in canonical form. Anything WHATWG parsing would silently
 * rewrite — whitespace, a dangling colon, a zero-padded port, a path fragment —
 * is refused, so a misconfigured entry cannot quietly broaden the grant.
 */
function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry);
	if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
	throw new Error(`dsh-lumen: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}

/** Whether the request authority matches a trustedHosts entry (exact, or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		assertTrustedAuthority(entry);
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

/**
 * Layer one: this plugin's own fence.
 *
 * @param {object} req node HTTP request (headers used)
 * @param {string[]} trustedHosts non-loopback authorities this deployment serves
 */
function passesOriginFence(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	// A cross-site fetch is refused even from a trusted authority: the check is
	// about who initiated the request, not who is hosting the page.
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/**
 * The host's own gate, read off whichever context is asking.
 *
 * Probed per call rather than captured once: the service can be composed after
 * this plugin mounts, and a fence that latched onto "absent" at load would stay
 * one layer short for the rest of the process life. `Reflect.get` is used
 * because the service's package is browser-side and cannot be imported here.
 */
function connectionOf(ctx) {
	try {
		const service = Reflect.get(ctx, "connection");
		// Only null / undefined mean "absent". An earlier version also required
		// `typeof === "object"`, which would have dropped layer two on a build that
		// exposed the service as a callable — and then *reported* the service as
		// missing. Getting an absent defence and a present one backwards is the one
		// mistake a fence cannot make, so the test for absence is as narrow as
		// possible.
		return service === null || service === undefined ? undefined : service;
	} catch {
		return undefined;
	}
}

/**
 * Layer two: ask the host whether it would refuse this request.
 *
 * `connection.requestRejection(request)` answers `403` when the host's own
 * Host/Origin fence rejects, `401` when the browser session is not
 * authenticated, and `undefined` when the request is fine. It is the **only**
 * route from a plugin's route handler to the host's browser authentication,
 * which is why a fence stopping at layer one is strictly weaker than the
 * host's own routes even when the two agree about everything both can see.
 *
 * Two asymmetries with a naive wrapper, both deliberate:
 *
 *   - a THROW is a rejection, not a pass. A fence that opens because the thing
 *     checking it misbehaved is not a fence.
 *   - only `undefined` passes. The host's own `admit()` compares against `void 0`
 *     rather than testing falsiness, so mirroring that keeps a future build that
 *     answered `null` from opening here while it closed there.
 *
 * @returns {number|undefined} the status to refuse with, or undefined to allow
 */
function hostRejection(connection, req) {
	if (connection === undefined || typeof connection.requestRejection !== "function") return undefined;
	let answer;
	try {
		answer = connection.requestRejection(req);
	} catch (error) {
		console.warn("[dsh-lumen] connection.requestRejection threw; refusing the request", error);
		return 403;
	}
	if (answer === undefined) return undefined;
	// A number in the 4xx/5xx range is the host's own verdict; anything else is
	// an answer we do not understand, and an answer we do not understand is not
	// a pass.
	if (typeof answer === "number" && answer >= 400 && answer <= 599) return answer;
	return 403;
}

/**
 * The one place that decides whether a request may reach this plugin's routes.
 *
 * @returns {number|undefined} the status to refuse with, or undefined to allow
 */
function fenceRejection(ctx, req, trustedHosts) {
	if (!passesOriginFence(req, trustedHosts)) return 403;
	return hostRejection(connectionOf(ctx), req);
}

/** Whether the load-time notice about a missing host gate has already been logged. */
let announcedMissingHostGate = false;

/**
 * Say once, at load, that layer two is not available on this host.
 *
 * A fence that silently lost a layer is worse than one that never had it: from
 * the outside the two are indistinguishable, so the weaker one gets trusted for
 * the stronger one's guarantees. The notice is emitted here, not per request,
 * because it is a property of the build rather than of any one call.
 */
function announceMissingHostGate(ctx) {
	if (announcedMissingHostGate) return;
	const connection = connectionOf(ctx);
	if (connection !== undefined && typeof connection.requestRejection === "function") return;
	announcedMissingHostGate = true;
	console.warn(
		"[dsh-lumen] this host exposes no usable `connection.requestRejection`; /lumen/api keeps its own Host/Origin fence and runs without the browser-session check"
	);
}

/** Authorities this deployment serves, or `[]` when the service cannot answer. */
function trustedHostsOf(ctx) {
	try {
		return Array.isArray(ctx.webRuntime && ctx.webRuntime.trustedHosts) ? ctx.webRuntime.trustedHosts : [];
	} catch {
		return [];
	}
}

// ── JSON body / response helpers ───────────────────────────────────────────

/** Sentinel: the request body exceeded {@link MAX_BODY_BYTES} (respond 413). */
const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

/** Read a JSON request body, capped at {@link MAX_BODY_BYTES}. */
function collectJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

/** Write a JSON response. */
function writeJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

/** A structured error response. */
function fail(res, status, code, message) {
	writeJson(res, status, { ok: false, error: { code, message } });
}

/**
 * Refuse a fenced request, naming the layer that refused it.
 *
 * 401 and 403 are different answers — "you are not who you say you are" versus
 * "this request is not allowed to reach this route" — and a client that branches
 * on the code should not have to guess which one it got from the status line
 * alone.
 */
function refuseFenced(res, status) {
	const code = status === 401 ? "unauthorized" : "forbidden";
	fail(res, status, code, code);
}

/**
 * Handle one fenced API request.
 *
 * Only the keys present in a `set` patch are touched: a string sets, `null`
 * removes, absent leaves alone. That is what makes the client's deletion path
 * work (it sends explicit nulls for keys it dropped) and what makes concurrent
 * writers safe.
 */
async function handleApi(req, res) {
	if (req.method !== "POST") {
		fail(res, 405, "method-error", "method not allowed");
		return;
	}
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json")) {
		// Narrow the surface: without this a form POST would parse as `{}` and be
		// handled as an empty merge.
		fail(res, 415, "unsupported-media-type", "content-type must be application/json");
		return;
	}
	const payload = await collectJsonBody(req);
	if (payload === PAYLOAD_TOO_LARGE) {
		fail(res, 413, "payload-too-large", "request body too large");
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.method !== "string") {
		fail(res, 400, "bad-request", "bad request");
		return;
	}
	if (payload.method === "get") {
		writeJson(res, 200, { ok: true, value: readPreferences() });
		return;
	}
	if (payload.method === "ping") {
		writeJson(res, 200, { ok: true, value: { file: documentPath(), bytes: documentBytes(), keys: Object.keys(readPreferences()).length } });
		return;
	}
	if (payload.method === "set") {
		const patch = payload.patch;
		if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
			fail(res, 400, "bad-request", "patch must be a plain object");
			return;
		}
		const next = readPreferences();
		for (const [key, value] of Object.entries(patch)) {
			if (key === STATE_SCHEMA_KEY) continue;
			// Only string / null values are accepted, so a compromised page cannot
			// smuggle a non-JSON type into the file.
			if (value === null) delete next[key];
			else if (typeof value === "string") next[key] = value;
		}
		const result = writePreferences(next);
		if (!result.ok) {
			// Refuse rather than truncate: a state that silently lost the user's
			// wallpaper is worse than a write that visibly failed.
			fail(res, 413, result.reason, `state rejected (${result.reason})`);
			return;
		}
		writeJson(res, 200, { ok: true, value: { bytes: result.bytes } });
		return;
	}
	fail(res, 404, "not-found", `unknown method "${payload.method}"`);
}

// ── splash media store ─────────────────────────────────────────────────────
//
// Media bytes never enter the state file (see the module doc). They live in one
// directory under the DSH home, under a name this file generates, and the state
// holds only that name. Building the served path from an allowlisted *shape*
// rather than from a supplied *string* is what makes path traversal structurally
// impossible here rather than defended against: there is no code path that joins
// anything a request contained.

/** Media directory inside the DSH home directory. */
const MEDIA_DIRNAME = "lumen-media";
/** Preference key naming the chosen splash media. Holds a file name, never bytes and never a path. */
const SPLASH_KEY = "splash.media";
/** Route prefix owned by the splash: one prefix, dispatched on the path tail. */
const SPLASH_PREFIX = "/lumen/splash";
/**
 * Largest upload accepted into the media directory, bytes.
 *
 * Deliberately far above what a splash should be and far below "whatever the
 * disk holds". The host's own browser-transport default is 300 MiB, so a body
 * this size is an ordinary request rather than a special case; the ceiling
 * exists to stop a runaway client, not to police the user's choice of clip.
 */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

/**
 * Accepted media types, mapped to the extension we store them under.
 *
 * The extension is derived from the request's own `content-type` and nothing
 * else, so a file name never comes from the caller. `webm` is here because this
 * build's Electron carries a full VP8/VP9 decoder; `ogv` because Theora is
 * present too. `mov` is deliberately absent: it usually means H.264 in a
 * container this build can decode, but it just as often means ProRes, and a
 * splash that silently fails to play is worse than one that was refused.
 */
const MEDIA_TYPES = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/webp", "webp"],
	["image/gif", "gif"],
	["image/avif", "avif"],
	["video/mp4", "mp4"],
	["video/webm", "webm"],
	["video/ogg", "ogv"]
]);
/** Extension → MIME. Derived from {@link MEDIA_TYPES} so the two cannot drift apart. */
const MEDIA_MIMES = new Map([...MEDIA_TYPES].map(([mime, extension]) => [extension, mime]));
/** The one shape a stored media name may have, with the extension allowlisted. */
const MEDIA_NAME_SHAPE = new RegExp(`^media-[0-9a-z]+-[0-9a-f]{8}\\.(${[...MEDIA_MIMES.keys()].join("|")})$`);

/** The media directory, created on demand. */
function mediaDirectory() {
	return join(dshHome(), MEDIA_DIRNAME);
}

/**
 * The configured splash media name, or undefined.
 *
 * The stored value is re-validated on every read rather than trusted because it
 * was validated on write: this file is shared with other processes, and an
 * older or newer build may have written it. A value that fails the shape check
 * is treated as "no splash", which is the same answer as an unset key — the
 * user sees the shell's own start screen instead of a broken cover.
 */
function splashName(preferences) {
	const value = preferences[SPLASH_KEY];
	return typeof value === "string" && MEDIA_NAME_SHAPE.test(value) ? value : undefined;
}

/**
 * Memo of the splash name, keyed on the state file's mtime and size.
 *
 * The inject handler runs on the INDEX request — the app's own startup path — and
 * the state file can hold up to 24 MiB of wallpaper payloads. Reading it afresh
 * there would put a synchronous parse of the user's entire document in front of
 * the first paint, to recover one short string.
 *
 * `mtimeMs` + `size` rather than `mtimeMs` alone, and our own writes clear the
 * memo outright. So the only miss left needs a DIFFERENT process to write a
 * document of byte-identical length inside one filesystem timestamp tick, and its
 * consequence is one stale cover on one page load — which the guard lifts anyway.
 */
let coverCache = null;
function splashNameForCover() {
	let stamp = null;
	try {
		const stat = statSync(documentPath());
		stamp = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		coverCache = null;
		return undefined;
	}
	if (coverCache !== null && coverCache.stamp === stamp) return coverCache.name;
	const name = splashName(readPreferences());
	coverCache = { stamp, name };
	return name;
}

/** Whether a media name names a picture or a clip. */
function splashKindOf(mediaName) {
	const extension = mediaName.slice(mediaName.lastIndexOf(".") + 1);
	const mime = MEDIA_MIMES.get(extension);
	// A name that reached here came through `splashName`, so its extension is
	// always allowlisted. Defaulting to "video" instead of throwing keeps a future
	// caller that skipped that step from taking the host down over a label.
	return typeof mime === "string" && mime.startsWith("image/") ? "image" : "video";
}

/**
 * Delete a media file.
 *
 * ENOENT is the ordinary case — the file was already gone. Anything else means
 * bytes are being left behind, and that deserves one loud line rather than
 * silence: a single orphaned clip is inert, but a directory that grows without
 * bound is the kind of thing a user finds a year later with no idea what made it.
 */
function discardMedia(file) {
	try {
		unlinkSync(file);
	} catch (error) {
		if (error && error.code !== "ENOENT") {
			console.warn(`[dsh-lumen] could not remove media file ${file}:`, error);
		}
	}
}

/** A `.part` file older than this belongs to an upload that will never finish. */
const STAGING_STALE_MS = 60 * 60 * 1000;

/**
 * Remove abandoned `.part` files.
 *
 * A staging file exists only while an upload is in flight, so an old one is
 * residue from a process that died mid-upload — the one case where bytes reach
 * the disk with nothing in the state pointing at them. The staleness window is
 * what makes this safe to run on the upload path: a second upload must not
 * delete the staging file a first one is still writing.
 */
function sweepStagingFiles(directory) {
	let names;
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	const cutoff = Date.now() - STAGING_STALE_MS;
	for (const entry of names) {
		if (!entry.endsWith(".part")) continue;
		const file = join(directory, entry);
		try {
			if (statSync(file).mtimeMs < cutoff) discardMedia(file);
		} catch {
			// Raced with another sweep, or unreadable. Nothing useful to do.
		}
	}
}

/**
 * Parse one `Range` header against a known entity size.
 *
 * `null` is not an error: it means "send the whole entity", which is always a
 * legal answer and the right one for every header we do not specifically
 * honour. This function only ever says no to a request that is syntactically
 * valid *and* names bytes we do not have.
 *
 * @returns {{start: number, end: number}|null|"unsatisfiable"}
 */
function parseByteRange(header, size) {
	if (typeof header !== "string") return null;
	// One range only. A multi-range request is legal HTTP but answers with a
	// multipart body, and a splash needs no part of that; falling back to the
	// whole entity is a correct response to it, so the shape check does the
	// refusing.
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return null;
	const start = match[1];
	const end = match[2];
	if (start === "" && end === "") return null;
	if (start === "") {
		// Suffix form: the LAST n bytes.
		const wanted = Number(end);
		if (!Number.isFinite(wanted)) return null;
		if (wanted === 0) return "unsatisfiable";
		return { start: Math.max(0, size - wanted), end: size - 1 };
	}
	const from = Number(start);
	if (!Number.isFinite(from) || from >= size) return "unsatisfiable";
	if (end === "") return { start: from, end: size - 1 };
	const to = Number(end);
	if (!Number.isFinite(to) || to < from) return "unsatisfiable";
	return { start: from, end: Math.min(to, size - 1) };
}

/**
 * Answer `GET`/`HEAD` on the media route from disk.
 *
 * Ranges are the point rather than a nicety: without them the browser must
 * download the whole clip before the first frame appears, which for a two
 * megabyte splash is exactly the two seconds the splash was supposed to fill.
 */
function serveSplashMedia(req, res, mediaName) {
	const file = join(mediaDirectory(), mediaName);
	let size;
	try {
		size = statSync(file).size;
	} catch {
		fail(res, 404, "no-media", "the configured splash media is missing");
		return;
	}
	const etag = `"${size.toString(16)}-${mediaName}"`;
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, { etag, "cache-control": "no-store" });
		res.end();
		return;
	}
	const range = parseByteRange(req.headers.range, size);
	if (range === "unsatisfiable") {
		// The entity size goes in the 416 so a client can retry with a range that
		// fits instead of guessing again.
		res.writeHead(416, { "content-range": `bytes */${size}`, "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: { code: "range-not-satisfiable", message: "range not satisfiable" } }));
		return;
	}
	// `no-store`, not a validator: a splash is replaced in place, and a cached
	// 206 would let a client stitch a new clip's head onto an old one's tail.
	const headers = {
		"content-type": MEDIA_MIMES.get(mediaName.slice(mediaName.lastIndexOf(".") + 1)),
		"accept-ranges": "bytes",
		"cache-control": "no-store",
		etag
	};
	if (range === null) {
		res.writeHead(200, { ...headers, "content-length": String(size) });
		if (req.method === "HEAD") {
			res.end();
			return undefined;
		}
		return sendMediaStream(res, file, null);
	}
	res.writeHead(206, {
		...headers,
		"content-range": `bytes ${range.start}-${range.end}/${size}`,
		"content-length": String(range.end - range.start + 1)
	});
	if (req.method === "HEAD") {
		res.end();
		return undefined;
	}
	return sendMediaStream(res, file, range);
}

/**
 * Copy a byte range of `file` into the response.
 *
 * `pipeline` rather than `pipe`, and not for style: `pipe` does not destroy the
 * source when the destination goes away, so every aborted playback would leave a
 * file handle open until the process ended. A splash is the one thing in this
 * plugin the user is invited to close, which makes that an ordinary path rather
 * than a theoretical one.
 */
async function sendMediaStream(res, file, range) {
	const source = range === null ? createReadStream(file) : createReadStream(file, { start: range.start, end: range.end });
	try {
		await pipeline(source, res);
	} catch (error) {
		// A client that hung up mid-stream is ordinary — people close windows. A
		// read that failed is not, and that is the case somebody needs to hear
		// about. `pipeline` has already torn down both ends either way.
		if (!res.destroyed && !res.writableEnded) {
			console.warn(`[dsh-lumen] media stream failed for ${file}:`, error);
		}
	}
}

/** A fresh media name. Never derived from anything the request carried. */
function freshMediaName(extension) {
	return `media-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${extension}`;
}

/**
 * Stream one upload into the media directory and point the splash at it.
 *
 * Written to a `.part` name and renamed only once the bytes are on disk, so a
 * connection that dies mid-upload cannot leave a truncated clip for the boot
 * cover to serve. If the state write then fails, the new file is removed: a
 * preference that names a file nobody referenced would survive restarts and
 * quietly fill the directory.
 */
function receiveSplashMedia(req, res) {
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].split(";")[0].trim().toLowerCase() : "";
	const extension = MEDIA_TYPES.get(contentType);
	if (extension === undefined) {
		fail(res, 415, "unsupported-media-type", `unsupported media type ${JSON.stringify(contentType)}`);
		return;
	}
	const directory = mediaDirectory();
	try {
		mkdirSync(directory, { recursive: true });
	} catch {
		fail(res, 500, "mkdir-failed", "media directory unavailable");
		return;
	}
	// Before creating ours, not after: a sweep that ran later would race the
	// staging file this very call is about to write.
	sweepStagingFiles(directory);
	const mediaName = freshMediaName(extension);
	const finalPath = join(directory, mediaName);
	const partPath = `${finalPath}.part`;
	const out = createWriteStream(partPath);
	let received = 0;
	let overflowed = false;
	let settled = false;
	const drained = new Promise((resolve) => {
		const settle = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		req.on("data", (chunk) => {
			if (overflowed) return;
			received += chunk.length;
			if (received > MAX_MEDIA_BYTES) {
				overflowed = true;
				req.destroy();
				out.destroy();
				settle();
				return;
			}
			out.write(chunk);
		});
		req.on("end", () => {
			if (overflowed) settle();
			else out.end(settle);
		});
		req.on("error", () => {
			out.destroy();
			settle();
		});
		req.on("close", settle);
	});
	return drained.then(() => {
		if (overflowed) {
			discardMedia(partPath);
			fail(res, 413, "payload-too-large", "media exceeds the accepted size");
			return;
		}
		if (received === 0) {
			discardMedia(partPath);
			fail(res, 400, "empty-body", "no bytes were sent");
			return;
		}
		try {
			renameSync(partPath, finalPath);
		} catch {
			discardMedia(partPath);
			fail(res, 500, "write-failed", "could not store the media");
			return;
		}
		// One read, one write. Reading twice would let a concurrent preference
		// change land in the first read and be overwritten by the second.
		const preferences = readPreferences();
		const previous = splashName(preferences);
		const result = writePreferences({ ...preferences, [SPLASH_KEY]: mediaName });
		if (!result.ok) {
			discardMedia(finalPath);
			fail(res, 413, result.reason, `state rejected (${result.reason})`);
			return;
		}
		// Only after the preference has moved: until then the old clip is still
		// the one the cover serves, and deleting it first would 404 a live splash.
		if (previous !== undefined && previous !== mediaName) discardMedia(join(directory, previous));
		writeJson(res, 200, { ok: true, value: { media: mediaName, kind: splashKindOf(mediaName), bytes: received } });
	});
}

/** Forget the splash and remove its bytes. */
function clearSplashMedia(res) {
	const preferences = readPreferences();
	const previous = splashName(preferences);
	if (previous === undefined) {
		writeJson(res, 200, { ok: true, value: { cleared: false } });
		return;
	}
	const next = { ...preferences };
	delete next[SPLASH_KEY];
	const result = writePreferences(next);
	if (!result.ok) {
		fail(res, 413, result.reason, `state rejected (${result.reason})`);
		return;
	}
	// Preference first, file second. The other order would leave the state
	// pointing at a file that is already gone — a broken cover instead of a
	// clean one — if the write then failed.
	discardMedia(join(mediaDirectory(), previous));
	writeJson(res, 200, { ok: true, value: { cleared: true } });
}

/** Dispatch one request on the splash prefix. */
function handleSplash(req, res) {
	let pathname = "";
	try {
		pathname = new URL(req.url, "http://localhost").pathname;
	} catch {
		pathname = "";
	}
	if (pathname === `${SPLASH_PREFIX}/media`) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			fail(res, 405, "method-error", "method not allowed");
			return;
		}
		const mediaName = splashName(readPreferences());
		if (mediaName === undefined) {
			fail(res, 404, "no-media", "no splash media is configured");
			return;
		}
		return serveSplashMedia(req, res, mediaName);
	}
	if (pathname === `${SPLASH_PREFIX}/upload`) {
		if (req.method !== "POST") {
			fail(res, 405, "method-error", "method not allowed");
			return;
		}
		return receiveSplashMedia(req, res);
	}
	if (pathname === `${SPLASH_PREFIX}/clear`) {
		if (req.method !== "POST") {
			fail(res, 405, "method-error", "method not allowed");
			return;
		}
		clearSplashMedia(res);
		return;
	}
	fail(res, 404, "not-found", "unknown splash route");
}

// ── the boot cover ─────────────────────────────────────────────────────────

/** Marker identifying our own injected stylesheet, for de-duplication and for the guard. */
const COVER_MARK = "dsh-lumen-splash-cover";
/**
 * Global the injected guard publishes so the page can take the cover over.
 *
 * Two functions, and the asymmetry between them is the whole contract. `lift`
 * removes the cover for good; `keep` says "not yet, I am still preparing".
 * `keep` deliberately does not cancel the deadline — it lengthens it — so the
 * one thing a buggy page cannot do is turn a bounded flash into a permanent
 * black screen.
 */
const COVER_BRIDGE = "__DSH_LUMEN_SPLASH__";
/**
 * The shell's application container, exactly as the shell's own index declares
 * it (`<div id="root"></div>`, and an explicit "web app: missing #root" throw if
 * it is absent). The cover rule below and the guard's handoff check both key on
 * it, so a build that renamed it would have to be discovered by a person rather
 * than guessed at by this file.
 */
const SHELL_ROOT_ID = "root";
/** The boot kernel's marker inside that container. */
const BOOT_SELECTOR = "[data-dsh-boot]";
/**
 * How long the cover may stand before the injected guard takes it down, ms.
 *
 * Generous on purpose. Firing early on a healthy start is a visible flash;
 * firing late only shortens a black screen that is already broken.
 */
const COVER_DEADLINE_MS = 10000;
/**
 * How long the cover may stand after a page asked to hold it, ms.
 *
 * The video case is the only caller: CSS cannot play a clip, so the release has
 * to wait for a frame, and a frame has to wait for the browser half. That wait
 * is bounded too, for the reason {@link COVER_BRIDGE} gives.
 */
const COVER_HELD_MS = 30000;

/**
 * The stylesheet that covers the application until the splash is ready.
 *
 * Hiding `#root` hides the shell's own boot layer with it — that layer is an
 * element inside `#root`, not a sibling of it — so there is nothing separate to
 * suppress. Forcing the base colour matters for the same reason the cover does:
 * the shell paints `body` white in a light scheme, and covering only the
 * application would leave that white on screen, reading as "the interface
 * appeared and then vanished".
 *
 * An IMAGE splash is complete in this stylesheet. It is served in the same
 * response as the document, so it paints on the first frame — before any client
 * module exists to be slow or to fail. Its release is complete in the guard
 * below, for the same reason: an image splash appears and gives way without the
 * browser half ever loading. A VIDEO splash needs the browser half, because
 * nothing in CSS can play one.
 */
function coverStyleText(mediaName) {
	const rules = [`/* ${COVER_MARK} */`, `#${SHELL_ROOT_ID}{visibility:hidden!important}`];
	if (splashKindOf(mediaName) === "image") {
		rules.push(
			`html,body{background-color:#000!important;background-image:url("${SPLASH_PREFIX}/media");`
			+ "background-position:center;background-size:cover;background-repeat:no-repeat!important}"
		);
	} else {
		rules.push("html,body{background-color:#000!important}");
	}
	return rules.join("\n");
}

/**
 * The bounded way out, as a fresh inline script.
 *
 * The cover is owned by the page and lifted by it exactly once, which is what
 * makes the release one-way. But "the page always lifts it" is an assumption,
 * and the failure if it is wrong is the worst kind: `#root` hidden leaves a
 * black screen with no way back, because the shell's own failure report renders
 * inside `#root` too.
 *
 * A NEW script per load is the safety property, not an implementation detail: a
 * cover whose timer lived in CSS would accumulate across reloads and eventually
 * release immediately, and a cover that cancelled itself by selector would lock
 * the interface away instead of releasing it. Removing the stylesheet element
 * outright is what makes the release permanent — there is nothing left to
 * reapply when the splash later unmounts.
 *
 * IT ALSO WAITS FOR THE HANDOFF, AND THAT IS WHY AN IMAGE NEEDS NO BUNDLE
 *
 * When the cover should come down is knowable, and the shell says so itself. Its
 * served index holds an empty `#root`; a boot kernel carrying `[data-dsh-boot]`
 * is rendered into it; the app's own `mountApp` finds
 * `:scope > [data-dsh-boot]` and hydrates it through `BootHandoff` — one commit
 * of the framework-free loading DOM, then the app. So "the marker stood, and is
 * gone" is exactly "the shell has taken over", and the wait belongs *here*
 * rather than in the browser half. A stylesheet that paints a picture must not
 * need a bundle to have loaded in order to stop painting it.
 *
 * The marker's absence alone is not the signal, which is easy to get wrong: a
 * build that never used a boot kernel renders straight into the container, and
 * an empty container is not a shell that has taken over. Both halves are
 * therefore required — no marker, and something in the container.
 *
 * `keep` is the one way to postpone all of this, it is what the video case uses,
 * and it is bounded (see {@link COVER_BRIDGE}).
 */
function guardScriptText() {
	return "(function(){try{"
		+ `var mark=${JSON.stringify(COVER_MARK)};`
		+ `var rootId=${JSON.stringify(SHELL_ROOT_ID)};`
		+ `var bootSel=${JSON.stringify(BOOT_SELECTOR)};`
		+ "var done=false;var held=false;var timer=null;var observer=null;"
		+ "var stop=function(){"
		+ "try{if(timer!==null)clearTimeout(timer);timer=null;}catch(e){}"
		+ "try{if(observer!==null)observer.disconnect();observer=null;}catch(e){}};"
		+ "var lift=function(){if(done)return;done=true;stop();try{"
		+ "var head=document.head;var sheets=head?head.getElementsByTagName('style'):[];var doomed=[];"
		+ "for(var i=0;i<sheets.length;i++){var text=sheets[i].textContent||'';if(text.indexOf(mark)!==-1)doomed.push(sheets[i]);}"
		+ "for(var j=0;j<doomed.length;j++){try{doomed[j].remove();}catch(e){}}"
		+ "}catch(e){}};"
		+ "var appRoot=function(){try{return document.getElementById(rootId);}catch(e){return null;}};"
		+ "var handedOver=function(){try{"
		+ "var node=appRoot();if(node===null)return false;"
		+ "if(node.querySelector(bootSel)!==null)return false;"
		+ "return node.childNodes.length>0;"
		+ "}catch(e){return false;}};"
		+ "var arm=function(ms){try{if(timer!==null)clearTimeout(timer);timer=setTimeout(lift,ms);}catch(e){}};"
		+ `arm(${COVER_DEADLINE_MS});`
		+ "var watch=function(){try{if(held||done)return;"
		+ "if(handedOver()){lift();return;}"
		+ "if(typeof MutationObserver!=='function')return;"
		+ "observer=new MutationObserver(function(){if(held||done)return;if(handedOver())lift();});"
		+ "observer.observe(document.documentElement,{childList:true,subtree:true});"
		+ "}catch(e){}};"
		+ "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',watch);}else{watch();}"
		+ `globalThis[${JSON.stringify(COVER_BRIDGE)}]={lift:lift,keep:function(){held=true;arm(${COVER_HELD_MS});}};`
		+ "}catch(e){}})();";
}

/**
 * The rows this plugin contributes to the shell's served HTML.
 *
 * Returned as a plain array so the rules can be asserted without a host. An
 * empty array is the important case: with no splash configured this plugin
 * contributes nothing at all, so a user who never sets one is exposed to none
 * of this code's risk rather than to a small amount of it.
 */
function coverRows(mediaName) {
	if (mediaName === undefined) return [];
	return [
		{ kind: "style", text: coverStyleText(mediaName) },
		{ kind: "script", placement: "head", text: guardScriptText() }
	];
}

// ── mounting ───────────────────────────────────────────────────────────────

/**
 * Host loader entry.
 * @param {object} ctx host cordis context (webServer, webRuntime)
 */
export function apply(ctx) {
	announceMissingHostGate(ctx);

	// FIRST, and synchronously. The injected row table is collected at host
	// startup, so a handler registered after that collection never contributes —
	// there is no refresh path. Nothing may be awaited above this line, and the
	// handler itself only reads a small file and pushes static strings.
	ctx.on("webserver/index-inject", (table) => {
		try {
			if (!Array.isArray(table)) return;
			const rows = coverRows(splashNameForCover());
			if (rows.length === 0) return;
			// One injection step owns the cover. A second would stack a duplicate
			// guard, and a duplicate guard is a second timer racing the first.
			const already = table.some((row) => row && row.kind === "style" && typeof row.text === "string" && row.text.includes(COVER_MARK));
			if (already) return;
			table.push(...rows);
		} catch {
			// A broken settings read must not break index rendering: without the
			// cover the user simply sees the shell's own start screen.
		}
	});

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			const rejection = fenceRejection(ctx, req, trustedHostsOf(ctx));
			if (rejection !== undefined) {
				refuseFenced(res, rejection);
				return;
			}
			try {
				await handleApi(req, res);
			} catch (error) {
				// Never echo the internal error: the trusted page does not need the
				// filesystem path that is in it.
				console.error("[dsh-lumen] persistence API error:", error);
				fail(res, 500, "internal", "internal error");
			}
		}
	}), "dsh-lumen: persistence API route");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: SPLASH_PREFIX,
		handler: async (req, res) => {
			const rejection = fenceRejection(ctx, req, trustedHostsOf(ctx));
			if (rejection !== undefined) {
				refuseFenced(res, rejection);
				return;
			}
			try {
				await handleSplash(req, res);
			} catch (error) {
				console.error("[dsh-lumen] splash route error:", error);
				fail(res, 500, "internal", "internal error");
			}
		}
	}), "dsh-lumen: splash routes");
}
