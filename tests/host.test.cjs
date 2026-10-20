"use strict";
/**
 * The host half, exercised through its own loader entry.
 *
 * Until now nothing in `tests/` touched `lib/index.js` at all: the module was
 * covered only by being read. That is survivable for a JSON store, but not for
 * a fence, because a fence fails *open* when it is wrong — every other kind of
 * bug here would at worst lose a wallpaper, while a fence bug hands the user's
 * disk to any page the browser happens to be showing.
 *
 * So the fence gets the coverage of a security boundary rather than of a
 * helper: one test per layer, plus the three asymmetries that are easy to get
 * backwards (a throw is a rejection, only `undefined` passes, an unintelligible
 * answer is not a pass).
 *
 * `lib/index.js` is ESM inside a CommonJS package, so it is reached by dynamic
 * `import`. The module-level "already warned" flag is genuine process state, so
 * the notice tests import a fresh instance through a cache-busting query rather
 * than depending on the order the tests happen to run in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const HOST_URL = pathToFileURL(path.join(__dirname, "..", "lib", "index.js")).href;
const ROUTE_PATH = "/lumen/api";
const SPLASH_PATH = "/lumen/splash";
const WALLPAPER_PATH = "/lumen/wallpaper";
const MEDIA_PATH = `${SPLASH_PATH}/media`;
const UPLOAD_PATH = `${SPLASH_PATH}/upload`;
const CLEAR_PATH = `${SPLASH_PATH}/clear`;
/** Pinned deliberately: the guard finds the cover by this string, so a rename must fail here first. */
const COVER_MARK = "dsh-lumen-splash-cover";
/** The clip the package ships with. Its size is what the built-in route must report. */
const BUILTIN_MEDIA = path.join(__dirname, "..", "media", "splash.mp4");
const BUILTIN_MEDIA_BYTES = fs.statSync(BUILTIN_MEDIA).size;

/** A 1×1 PNG. The bytes are irrelevant to the store; only their length and round-trip are. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
	"base64"
);

/** Distinct instances of the host module, for the process-level "warn once" flag. */
let instanceCount = 0;
function freshHost() {
	instanceCount += 1;
	return import(`${HOST_URL}?instance=${instanceCount}`);
}

/**
 * A cordis context double just wide enough for `apply`.
 *
 * `connection` is attached to the context object itself because the host reads
 * it with `Reflect.get(ctx, "connection")`; a plain property is exactly what
 * that call sees.
 */
function makeContext(options) {
	const opts = options || {};
	const routes = [];
	const labels = [];
	const injectHandlers = [];
	const ctx = {
		effect: (fn, label) => {
			labels.push(label);
			return fn();
		},
		on: (event, handler) => {
			if (event === "webserver/index-inject") injectHandlers.push(handler);
			return () => {};
		},
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {};
			}
		},
		webRuntime: { trustedHosts: opts.trustedHosts || [] }
	};
	if (opts.connection !== undefined) ctx.connection = opts.connection;
	return { ctx, routes, labels, injectHandlers };
}

/** A request double that can deliver a body on demand. */
function makeRequest(spec) {
	const s = spec || {};
	const listeners = new Map();
	const req = {
		method: s.method === undefined ? "POST" : s.method,
		url: s.url === undefined ? "/" : s.url,
		headers: Object.assign({ host: "127.0.0.1:7341", "content-type": "application/json" }, s.headers),
		destroy() {},
		on(event, fn) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(fn);
			return req;
		},
		send(payload) {
			const chunk = Buffer.isBuffer(payload)
				? payload
				: Buffer.from(payload === undefined ? "" : String(payload), "utf8");
			for (const fn of listeners.get("data") || []) fn(chunk);
			for (const fn of listeners.get("end") || []) fn();
		}
	};
	return req;
}

/**
 * A response double that is a real Writable.
 *
 * It has to be one: the media route `pipe`s a file into the response, so a plain
 * object with `writeHead`/`end` would fail on the first byte. `body` is a getter
 * because `pipe` writes asynchronously — the bytes are only all there once the
 * stream has finished, which is what {@link callHost} waits for.
 */
function makeResponse() {
	const chunks = [];
	const res = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			callback();
		}
	});
	res.status = 0;
	res.headers = null;
	res.writeHead = (status, headers) => {
		res.status = status;
		res.headers = headers === undefined ? {} : headers;
	};
	const finish = res.end.bind(res);
	res.end = (payload, encoding, callback) => {
		if (typeof payload === "string") chunks.push(Buffer.from(payload, "utf8"));
		else if (Buffer.isBuffer(payload)) chunks.push(payload);
		return finish(undefined, encoding, callback);
	};
	Object.defineProperty(res, "body", { get: () => Buffer.concat(chunks).toString("utf8") });
	Object.defineProperty(res, "bytes", { get: () => Buffer.concat(chunks) });
	return res;
}

/** Resolve once the response can no longer receive bytes. */
function responseSettled(res) {
	if (res.writableEnded || res.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		res.once("finish", resolve);
		res.once("close", resolve);
		res.once("error", resolve);
	});
}

/**
 * Drive one request all the way through a route handler.
 *
 * Awaiting the handler is NOT enough: it resolves as soon as it has decided what
 * to send, while a piped body is still being copied. Tests that read the body
 * without this would pass or fail on a race.
 */
async function callHost(route, req, body) {
	const res = makeResponse();
	const pending = route.handler(req, res);
	if (body !== undefined) req.send(body);
	await pending;
	await responseSettled(res);
	return res;
}

/** Mount the host half and hand back its routes, keyed by path. */
async function mount(options) {
	const opts = options || {};
	const host = await freshHost();
	const built = makeContext(opts);
	// Most tests have no interest in the load-time notice; the ones that do
	// capture it from an instance of their own.
	if (opts.quiet !== false) {
		const original = console.warn;
		console.warn = () => {};
		try {
			host.apply(built.ctx);
		} finally {
			console.warn = original;
		}
	} else {
		host.apply(built.ctx);
	}
	assert.equal(built.routes.length, 3, "the host half must mount the persistence route, the splash routes and the illustration route");
	const byPath = new Map(built.routes.map((route) => [route.path, route]));
	assert.ok(byPath.has(ROUTE_PATH), `no route at ${ROUTE_PATH}`);
	assert.ok(byPath.has(SPLASH_PATH), `no route at ${SPLASH_PATH}`);
	assert.ok(byPath.has(WALLPAPER_PATH), `no route at ${WALLPAPER_PATH}`);
	return {
		host,
		routes: built.routes,
		route: byPath.get(ROUTE_PATH),
		splash: byPath.get(SPLASH_PATH),
		wallpapers: byPath.get(WALLPAPER_PATH),
		inject: built.injectHandlers,
		labels: built.labels,
		ctx: built.ctx
	};
}

/** Run `fn` with `DSH_HOME` pointed at a throwaway directory. */
async function withTempHome(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lumen-host-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		return await fn(dir);
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// A leftover temp directory is not worth failing a green suite over.
		}
	}
}

/** Run `fn` with `console.warn` captured. */
function captureWarnings(fn) {
	const original = console.warn;
	const seen = [];
	console.warn = (...args) => seen.push(args.map(String).join(" "));
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return seen;
}

/** Upload `PNG` and return the stored media name. */
async function uploadPng(splash) {
	const res = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": "image/png" } }), PNG);
	assert.equal(res.status, 200, `upload failed: ${res.body}`);
	return JSON.parse(res.body).value.media;
}

/** Route that switches the splash back to the packaged clip. */
const BUILTIN_PATH = `${SPLASH_PATH}/builtin`;

const PING = JSON.stringify({ method: "ping" });

// ── the contract the loader reads ──────────────────────────────────────────

test("the host half declares the services it needs to mount", async () => {
	const host = await freshHost();
	assert.equal(host.name, "dsh-lumen");
	assert.deepEqual(host.inject, ["webServer"]);
});

/**
 * The bug this test exists for, in one sentence: `inject` is a list of services
 * the fiber will WAIT for, and this cordis build has no optional form — an entry
 * nothing provides leaves `apply` un-called forever, silently.
 *
 * `webRuntime` was on that list and no shipped DSH build provides a service by
 * that name. The host half therefore never mounted: `/lumen/api` answered `404`
 * instead of the `401` a mounted route gives, state quietly fell back to
 * `localStorage`, and a splash could never be uploaded — "开屏不能用" with no
 * error anywhere to explain it.
 */
test("nothing is demanded that the host does not provide", async () => {
	const host = await freshHost();
	const provided = ["webServer", "connection", "credentials"];
	for (const name of host.inject) {
		assert.ok(provided.includes(name), `${name} is demanded but no shipped host provides it, so apply() would never run`);
	}
	assert.ok(!host.inject.includes("webRuntime"), "webRuntime does not exist in any shipped build; demanding it disables the whole host half");
});

test("connection is probed rather than required, so a build without it still mounts", async () => {
	const host = await freshHost();
	assert.ok(!host.inject.includes("connection"), "demanding the host gate would turn a hardening into an outage");
});

test("it mounts all three fenced prefix routes, and the fence is not optional", async () => {
	const mounted = await mount({});
	for (const route of mounted.routes) {
		assert.equal(route.kind, "prefix");
		assert.equal(typeof route.handler, "function");
	}
	assert.deepEqual(mounted.labels, ["dsh-lumen: persistence API route", "dsh-lumen: splash routes", "dsh-lumen: bundled illustration route"]);
});

// ── mounting against a service that is not there yet ──────────────────────

/**
 * A context shaped like the real one: reading `webServer` before the service is
 * composed THROWS (cordis refuses a property it was not asked to inject), and
 * `inject` is the only way to ask for it.
 *
 * The old double could not express this — it had `webServer` sitting on the
 * context from the start — which is exactly why the suite stayed green while
 * every host-side feature was dead on a real installation.
 */
function makeDeferredContext() {
	const routes = [];
	const labels = [];
	let release = null;
	const sub = {
		effect: (fn, label) => {
			labels.push(label);
			return fn();
		},
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {};
			}
		}
	};
	const ctx = {
		effect: (fn, label) => {
			labels.push(label);
			return fn();
		},
		on: () => () => {},
		inject: (names, callback) => {
			assert.deepEqual(names, ["webServer"], "the plugin must ask for the service rather than grab it");
			release = () => callback(sub);
			return () => {};
		}
	};
	Object.defineProperty(ctx, "webServer", {
		get() {
			throw new Error('cannot get property "webServer" without inject');
		}
	});
	return { ctx, routes, labels, release: () => release !== null && release(), asked: () => release !== null };
}

test("apply never touches a service it has not asked for, and mounts once it answers", async () => {
	const host = await freshHost();
	const deferred = makeDeferredContext();
	assert.doesNotThrow(() => host.apply(deferred.ctx), "a context whose webServer is not composed yet must not be fatal");
	assert.ok(deferred.asked(), "the plugin never asked for the web server");
	assert.equal(deferred.routes.length, 0, "a route was mounted before the service existed");
	deferred.release();
	assert.equal(deferred.routes.length, 3, "the routes did not mount when the web server arrived");
	assert.deepEqual(deferred.labels, ["dsh-lumen: persistence API route", "dsh-lumen: splash routes", "dsh-lumen: bundled illustration route"]);
});

test("the index-inject listener is registered before anything that can fail", async () => {
	// A throw from `apply` fails the whole fiber, which disposes the listeners
	// registered before it — so the cover injection has to be the first thing
	// that happens, not the last.
	const host = await freshHost();
	const order = [];
	const ctx = {
		effect: (fn, label) => {
			order.push(`effect:${label}`);
			return fn();
		},
		on: (event) => {
			order.push(`on:${event}`);
			return () => {};
		},
		inject: () => {
			order.push("inject:webServer");
			return () => {};
		}
	};
	try {
		host.apply(ctx);
	} catch {}
	assert.equal(order[0], "on:webserver/index-inject", "the injection handler was not the first registration");
});

// ── layer one: this plugin's own Host/Origin validator ─────────────────────

test("layer one admits a loopback same-origin request when the host offers no gate", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { origin: "http://127.0.0.1:7341" } }), PING);
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(res.body).ok, true);
});

test("layer one refuses a cross-site fetch even from a loopback authority", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { "sec-fetch-site": "cross-site" } }), PING);
	assert.equal(res.status, 403);
});

test("layer one refuses an Origin that does not match Host", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { origin: "http://evil.example" } }), PING);
	assert.equal(res.status, 403);
});

test("layer one refuses a non-loopback Host when no authority is configured", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { host: "evil.example" } }), PING);
	assert.equal(res.status, 403);
});

test("layer one refuses a request with no Host at all", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { host: undefined } }), PING);
	assert.equal(res.status, 403);
});

test("the splash routes sit behind the same fence", async () => {
	const { splash } = await mount({});
	const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { "sec-fetch-site": "cross-site" } }));
	assert.equal(res.status, 403, "a second route must not be a second, weaker door");
});

// ── layer two: the host's own gate ────────────────────────────────────────

test("layer two forwards the host's 401 verbatim", async () => {
	const { route } = await mount({ connection: { requestRejection: () => 401 } });
	const res = await callHost(route, makeRequest({}), PING);
	assert.equal(res.status, 401);
});

test("layer two forwards the host's 403 verbatim", async () => {
	const { route } = await mount({ connection: { requestRejection: () => 403 } });
	const res = await callHost(route, makeRequest({}), PING);
	assert.equal(res.status, 403);
});

test("a gate that throws refuses the request rather than allowing it", async () => {
	const { route } = await mount({
		connection: {
			requestRejection: () => {
				throw new Error("browserAuth is not ready");
			}
		}
	});
	const original = console.warn;
	const seen = [];
	console.warn = (...args) => seen.push(args.map(String).join(" "));
	let status;
	try {
		status = (await callHost(route, makeRequest({}), PING)).status;
	} finally {
		console.warn = original;
	}
	assert.equal(status, 403, "a fence that opens because the thing checking it misbehaved is not a fence");
	assert.equal(seen.length, 1, "a refused-by-exception request must be visible in the log, not silent");
	assert.ok(seen[0].includes("requestRejection"));
});

test("only undefined passes the gate; null is a rejection", async () => {
	const passes = await mount({ connection: { requestRejection: () => undefined } });
	assert.equal((await callHost(passes.route, makeRequest({}), PING)).status, 200);

	const refuses = await mount({ connection: { requestRejection: () => null } });
	assert.equal((await callHost(refuses.route, makeRequest({}), PING)).status, 403);
});

test("an answer we do not understand is not a pass", async () => {
	for (const answer of [200, true, "ok", {}]) {
		const { route } = await mount({ connection: { requestRejection: () => answer } });
		const res = await callHost(route, makeRequest({}), PING);
		assert.equal(res.status, 403, `an answer of ${JSON.stringify(answer)} must not open the gate`);
	}
});

test("a service object without requestRejection is treated as no gate at all", async () => {
	const { route } = await mount({ connection: {} });
	const res = await callHost(route, makeRequest({}), PING);
	assert.equal(res.status, 200, "layer one still stands on its own");
});

test("the gate is probed per request, so a late-arriving service is still used", async () => {
	const built = makeContext({});
	const host = await freshHost();
	const original = console.warn;
	console.warn = () => {};
	try {
		host.apply(built.ctx);
	} finally {
		console.warn = original;
	}
	const route = built.routes.find((entry) => entry.path === ROUTE_PATH);
	assert.equal((await callHost(route, makeRequest({}), PING)).status, 200, "no gate yet");

	// The composition attaches the service after this plugin mounted. A fence
	// that latched onto "absent" at load would stay a layer short forever.
	built.ctx.connection = { requestRejection: () => 401 };
	assert.equal((await callHost(route, makeRequest({}), PING)).status, 401);
});

// ── the load-time notice ──────────────────────────────────────────────────

test("a build with no usable gate says so once, at load", async () => {
	const host = await freshHost();
	const first = makeContext({});
	const second = makeContext({});
	const warnings = captureWarnings(() => {
		host.apply(first.ctx);
		host.apply(second.ctx);
	});
	assert.equal(warnings.length, 1, "one build, one notice — a per-request warning would be noise");
	assert.ok(warnings[0].includes("connection.requestRejection"));
});

test("a build with a usable gate does not warn", async () => {
	const host = await freshHost();
	const built = makeContext({ connection: { requestRejection: () => undefined } });
	const warnings = captureWarnings(() => {
		host.apply(built.ctx);
	});
	assert.deepEqual(warnings, []);
});

// ── the persistence API behind the fence ─────────────────────────────────

test("the persistence API round-trips: set merges, get returns, null deletes", async () => {
	await withTempHome(async (dir) => {
		const { route } = await mount({});
		const set = await callHost(route, makeRequest({}), JSON.stringify({ method: "set", patch: { "wash.alpha": "0.42", "splash.kind": "video" } }));
		assert.equal(set.status, 200);

		const got = await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }));
		const value = JSON.parse(got.body).value;
		assert.equal(value["wash.alpha"], "0.42");
		assert.equal(value["splash.kind"], "video");
		assert.ok(!("dsh-lumen:schema-version" in value), "the schema stamp must never reach the browser");

		// A patch that only mentions one key must leave the others alone — that
		// is what keeps two open windows from rolling each other back.
		await callHost(route, makeRequest({}), JSON.stringify({ method: "set", patch: { "wash.alpha": null } }));
		const after = JSON.parse((await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }))).body).value;
		assert.ok(!("wash.alpha" in after), "an explicit null removes the key");
		assert.equal(after["splash.kind"], "video", "a key absent from the patch is left alone");

		const ping = JSON.parse((await callHost(route, makeRequest({}), PING)).body).value;
		assert.ok(ping.file.startsWith(dir), `the ping should report the file it actually writes: ${ping.file}`);
		assert.ok(ping.bytes > 0);
	});
});

test("a non-JSON content type is refused before the body is read", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ headers: { "content-type": "text/plain" } }), "{}");
	assert.equal(res.status, 415);
});

test("a GET is refused: the API is POST-only", async () => {
	const { route } = await mount({});
	const res = await callHost(route, makeRequest({ method: "GET" }));
	assert.equal(res.status, 405);
});

// ── the boot cover ────────────────────────────────────────────────────────
//
// The cover is the one piece of this plugin that can take the whole interface
// away, so what it does when a splash is NOT configured matters more than what
// it does when one is.

test("a fresh install is covered by the clip the package ships with", async () => {
	// The default is no longer "nothing": a package that carries a splash shows
	// it without anybody asking. This is the test that would have caught the
	// feature being half-wired — a served clip with no cover is invisible, and a
	// cover with no clip is a black screen.
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		assert.equal(inject.length, 1, "the injection handler must be registered once");
		const table = [];
		inject[0](table);
		assert.equal(table.length, 2, "a fresh install must inject the cover and its guard");
		const style = table.find((row) => row.kind === "style").text;
		assert.ok(style.includes(COVER_MARK));
		assert.ok(!style.includes("background-image"), "the built-in splash is a clip, and CSS cannot paint one");

		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "HEAD" }));
		assert.equal(res.status, 200, "the clip named by the cover must actually be served");
		assert.equal(res.headers["content-type"], "video/mp4");
		assert.equal(res.headers["x-lumen-splash-source"], "builtin", "the panel cannot label the source without this");
		assert.equal(Number(res.headers["content-length"]), BUILTIN_MEDIA_BYTES);
	});
});

test("switching the splash off contributes no rows at all", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		const cleared = await callHost(splash, makeRequest({ url: CLEAR_PATH, method: "POST" }));
		assert.equal(cleared.status, 200);
		assert.equal(JSON.parse(cleared.body).value.cleared, true, "turning a default splash off is a change, not a no-op");
		const table = [{ kind: "global", name: "x", value: 1 }];
		inject[0](table);
		assert.deepEqual(table, [{ kind: "global", name: "x", value: 1 }], "a user who switched the splash off must be exposed to none of this");
		const media = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(media.status, 404);
		// Off is remembered as off, not as "never chose anything" — otherwise the
		// next version's default would quietly come back.
		const clearedAgain = await callHost(splash, makeRequest({ url: CLEAR_PATH, method: "POST" }));
		assert.equal(JSON.parse(clearedAgain.body).value.cleared, false);
	});
});

test("a configured image contributes a cover stylesheet and exactly one guard script", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const table = [];
		inject[0](table);
		assert.equal(table.length, 2);
		const style = table.find((row) => row.kind === "style");
		const script = table.find((row) => row.kind === "script");
		assert.ok(style, "no cover stylesheet was injected");
		assert.ok(style.text.includes(COVER_MARK), "the guard finds the cover by this marker");
		assert.equal(script.placement, "head", "the guard must run before the application does");
		assert.ok(!table.some((row) => row.kind === "html"), "nothing is injected into the body");
	});
});

test("the cover hides #root and forces the base colour dark", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const table = [];
		inject[0](table);
		const style = table.find((row) => row.kind === "style").text;
		assert.ok(style.includes("#root{visibility:hidden!important}"), "the application must be covered");
		assert.ok(style.includes("background-color:#000!important"), "a light-scheme body would flash white through the cover");
		assert.ok(!style.includes("dsh-boot-spinner"), "that element does not exist in this build, so suppressing it would be dead CSS");
	});
});

test("an image cover paints the media itself, so it needs no client module at all", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const table = [];
		inject[0](table);
		const style = table.find((row) => row.kind === "style").text;
		assert.ok(style.includes(`url("${MEDIA_PATH}")`), "the picture should paint on the first frame, not when a module loads");
	});
});

test("a video cover does not pretend CSS can play a clip", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		const res = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": "video/mp4" } }), PNG);
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).value.kind, "video");
		const table = [];
		inject[0](table);
		const style = table.find((row) => row.kind === "style").text;
		assert.ok(!style.includes("background-image"), "a background-image of an mp4 would render as nothing at all");
		assert.ok(style.includes("#root{visibility:hidden!important}"));
	});
});

test("a second injection step does not stack a duplicate guard", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const table = [];
		inject[0](table);
		const afterFirst = table.length;
		inject[0](table);
		assert.equal(table.length, afterFirst, "two guards would be two timers racing to lift one cover");
	});
});

test("the guard arms a bounded timer and publishes a release the page can call", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const table = [];
		inject[0](table);
		const script = table.find((row) => row.kind === "script").text;
		assert.ok(script.includes("setTimeout"), "without a deadline a broken start is a black screen forever");
		assert.ok(script.includes("10000"), "the deadline should be the documented ten seconds");
		assert.ok(script.includes("__DSH_LUMEN_SPLASH__"), "the page needs a handle to lift the cover early");
		assert.ok(script.includes(COVER_MARK), "the guard must look for our marker, not a guess");
		assert.ok(script.includes("remove()"), "removing the element is what makes the release one-way");
	});
});

test("a stored name that is not our own shape is treated as no splash", async () => {
	await withTempHome(async () => {
		const { route, splash, inject } = await mount({});
		for (const planted of ["../../etc/passwd", "media-x.png", "media-abc-01234567.exe", ""]) {
			// `splash.source` says the user's own clip is the choice, so a name
			// that fails the shape check is a broken choice — not a reason to
			// fall back to the built-in clip behind the user's back.
			await callHost(route, makeRequest({}), JSON.stringify({ method: "set", patch: { "splash.media": planted, "splash.source": "custom" } }));
			const table = [];
			inject[0](table);
			assert.deepEqual(table, [], `a stored value of ${JSON.stringify(planted)} must not produce a cover`);
			const media = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
			assert.equal(media.status, 404, `a stored value of ${JSON.stringify(planted)} must not be served`);
		}
	});
});

test("an unreadable stored name falls back to the built-in clip, not to a path", async () => {
	// The upgrade path: a document written before `splash.source` existed carries
	// only `splash.media`. A garbage value there must land on the built-in clip,
	// and the bytes served must be the package's own — never the stored string.
	await withTempHome(async () => {
		const { route, splash } = await mount({});
		await callHost(route, makeRequest({}), JSON.stringify({ method: "set", patch: { "splash.media": "../../etc/passwd" } }));
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(res.status, 200);
		assert.equal(res.headers["x-lumen-splash-source"], "builtin");
		assert.equal(res.bytes.length, BUILTIN_MEDIA_BYTES, "the served bytes are not the packaged clip");
	});
});

// ── the media route ───────────────────────────────────────────────────────

test("the media route is 404 once the splash is switched off", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await callHost(splash, makeRequest({ url: CLEAR_PATH, method: "POST" }));
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(res.status, 404);
	});
});

test("the media route serves the whole entity and advertises ranges", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-type"], "image/png");
		assert.equal(res.headers["accept-ranges"], "bytes", "without this the browser will not even try a range");
		assert.equal(res.headers["cache-control"], "no-store");
		assert.equal(res.bytes.length, PNG.length);
		assert.ok(res.bytes.equals(PNG), "the bytes served must be the bytes uploaded");
	});
});

test("a satisfied range answers 206 with a content-range", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { range: "bytes=0-9" } }));
		assert.equal(res.status, 206);
		assert.equal(res.headers["content-range"], `bytes 0-9/${PNG.length}`);
		assert.equal(res.headers["content-length"], "10");
		assert.ok(res.bytes.equals(PNG.subarray(0, 10)));
	});
});

test("an open-ended range runs to the last byte", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { range: "bytes=4-" } }));
		assert.equal(res.status, 206);
		assert.equal(res.headers["content-range"], `bytes 4-${PNG.length - 1}/${PNG.length}`);
		assert.ok(res.bytes.equals(PNG.subarray(4)));
	});
});

test("a suffix range answers the LAST n bytes", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { range: "bytes=-6" } }));
		assert.equal(res.status, 206);
		assert.equal(res.headers["content-range"], `bytes ${PNG.length - 6}-${PNG.length - 1}/${PNG.length}`);
		assert.ok(res.bytes.equals(PNG.subarray(PNG.length - 6)));
	});
});

test("a range past the end answers 416 with the entity size", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		for (const header of [`bytes=${PNG.length}-`, `bytes=${PNG.length + 5}-${PNG.length + 9}`, "bytes=-0", "bytes=9-3"]) {
			const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { range: header } }));
			assert.equal(res.status, 416, `${header} should be unsatisfiable`);
			assert.equal(res.headers["content-range"], `bytes */${PNG.length}`, "a 416 must tell the client what would fit");
		}
	});
});

test("a range we do not honour falls back to the whole entity rather than 416", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		for (const header of ["items=0-1", "bytes=0-1,4-5", "bytes=abc", "bytes=", "bytes=5-2x"]) {
			const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { range: header } }));
			assert.equal(res.status, 200, `${header} should fall back to the whole entity`);
			assert.ok(res.bytes.equals(PNG));
		}
	});
});

test("an unchanged etag answers 304 with no body", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const first = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET", headers: { "if-none-match": first.headers.etag } }));
		assert.equal(res.status, 304);
		assert.equal(res.bytes.length, 0);
	});
});

test("HEAD answers the same headers with no body", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "HEAD" }));
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-length"], String(PNG.length));
		assert.equal(res.bytes.length, 0);
	});
});

test("the media route refuses anything but GET and HEAD", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "POST" }), PNG);
		assert.equal(res.status, 405);
	});
});

// ── upload and clearing ───────────────────────────────────────────────────

test("an upload stores the bytes and points the splash at them", async () => {
	await withTempHome(async (dir) => {
		const { route, splash } = await mount({});
		const mediaName = await uploadPng(splash);
		assert.match(mediaName, /^media-[0-9a-z]+-[0-9a-f]{8}\.png$/, "the name must be one we generated");
		const stored = fs.readFileSync(path.join(dir, "lumen-media", mediaName));
		assert.ok(stored.equals(PNG));

		const preferences = JSON.parse((await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }))).body).value;
		assert.equal(preferences["splash.media"], mediaName, "the state holds the name, never the path or the bytes");
		assert.ok(!fs.existsSync(path.join(dir, "lumen-media", `${mediaName}.part`)), "the staging file must not survive");
	});
});

test("replacing a splash removes the bytes it replaced", async () => {
	await withTempHome(async (dir) => {
		const { splash } = await mount({});
		const first = await uploadPng(splash);
		const second = await uploadPng(splash);
		assert.notEqual(first, second);
		assert.ok(!fs.existsSync(path.join(dir, "lumen-media", first)), "the replaced clip would otherwise sit on disk forever");
		assert.ok(fs.existsSync(path.join(dir, "lumen-media", second)));
	});
});

test("switching to the built-in clip replaces the user's own, like an upload does", async () => {
	await withTempHome(async (dir) => {
		const { route, splash } = await mount({});
		const mediaName = await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: BUILTIN_PATH, method: "POST" }));
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).value.source, "builtin");
		assert.ok(!fs.existsSync(path.join(dir, "lumen-media", mediaName)), "a clip nothing points at would sit on disk forever");
		const served = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(served.headers["x-lumen-splash-source"], "builtin");
		assert.equal(served.bytes.length, BUILTIN_MEDIA_BYTES);
		const preferences = JSON.parse((await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }))).body).value;
		assert.ok(!("splash.media" in preferences), "the state still names a file that is gone");
	});
});

test("an upload wins over the built-in clip", async () => {
	await withTempHome(async () => {
		const { route, splash } = await mount({});
		const mediaName = await uploadPng(splash);
		const preferences = JSON.parse((await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }))).body).value;
		assert.equal(preferences["splash.source"], "custom", "the upload did not take ownership of the source");
		const served = await callHost(splash, makeRequest({ url: MEDIA_PATH, method: "GET" }));
		assert.equal(served.headers["x-lumen-splash-source"], "custom");
		assert.equal(served.headers["content-type"], "image/png");
		assert.ok(served.bytes.equals(PNG), `the built-in clip was served instead of ${mediaName}`);
	});
});

test("clearing forgets the splash and removes its bytes", async () => {
	await withTempHome(async (dir) => {
		const { route, splash } = await mount({});
		const mediaName = await uploadPng(splash);
		const res = await callHost(splash, makeRequest({ url: CLEAR_PATH }));
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).value.cleared, true);
		assert.ok(!fs.existsSync(path.join(dir, "lumen-media", mediaName)));
		const preferences = JSON.parse((await callHost(route, makeRequest({}), JSON.stringify({ method: "get" }))).body).value;
		assert.ok(!("splash.media" in preferences));

		const again = await callHost(splash, makeRequest({ url: CLEAR_PATH }));
		assert.equal(JSON.parse(again.body).value.cleared, false, "clearing twice is not an error");
	});
});

test("an unsupported media type is refused before anything is written", async () => {
	await withTempHome(async (dir) => {
		const { splash, inject } = await mount({});
		for (const type of ["video/quicktime", "application/zip", "image/svg+xml", ""]) {
			const res = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": type } }), PNG);
			assert.equal(res.status, 415, `${JSON.stringify(type)} should be refused`);
		}
		assert.ok(!fs.existsSync(path.join(dir, "lumen-media")), "a refused upload must not leave a directory behind");
		// The default splash is still standing, and it is still the clip: a
		// refused upload must not have turned the cover into an image cover.
		const table = [];
		inject[0](table);
		const style = table.find((row) => row.kind === "style").text;
		assert.ok(!style.includes("background-image"), "a refused upload still changed what the cover paints");
	});
});

test("an empty upload is refused and leaves nothing behind", async () => {
	await withTempHome(async (dir) => {
		const { splash } = await mount({});
		const res = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": "image/png" } }), Buffer.alloc(0));
		assert.equal(res.status, 400);
		const leftovers = fs.existsSync(path.join(dir, "lumen-media")) ? fs.readdirSync(path.join(dir, "lumen-media")) : [];
		assert.deepEqual(leftovers, []);
	});
});

test("an unknown splash path is 404, and the wrong method is 405", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		assert.equal((await callHost(splash, makeRequest({ url: `${SPLASH_PATH}/nope`, method: "GET" }))).status, 404);
		assert.equal((await callHost(splash, makeRequest({ url: UPLOAD_PATH, method: "GET" }))).status, 405);
		assert.equal((await callHost(splash, makeRequest({ url: CLEAR_PATH, method: "GET" }))).status, 405);
	});
});

// ── the bundled illustrations ─────────────────────────────────────────────
//
// The four drawings are the only pixels this package ships. They are served
// rather than inlined (a 300KB JPEG is ~400KB of base64, against a 512KB bundle
// budget), which makes this route the one thing standing between a built-in
// wallpaper and a 404 — so it gets the same treatment as the splash media route:
// exact bytes, revalidating etag, and a name allowlist that is the directory
// rather than a copy of a list.

test("the illustration route serves a bundled picture byte-for-byte", async () => {
	await withTempHome(async () => {
		const { wallpapers } = await mount({});
		const file = path.join(__dirname, "..", "media", "wallpapers", "whale-sunset.jpg");
		const bytes = fs.statSync(file).size;

		const res = await callHost(wallpapers, makeRequest({ url: `${WALLPAPER_PATH}/whale-sunset.jpg`, method: "GET" }));
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-type"], "image/jpeg");
		assert.equal(res.headers["content-length"], String(bytes));
		assert.equal(res.headers["cache-control"], "no-cache", "a long max-age would outlive the version that filled it");
		assert.ok(res.headers.etag, "no validator means no way to notice a changed picture");
		assert.equal(res.bytes.length, bytes, "the body is not the file");

		const head = await callHost(wallpapers, makeRequest({ url: `${WALLPAPER_PATH}/whale-sunset.jpg`, method: "HEAD" }));
		assert.equal(head.status, 200);
		assert.equal(head.headers["content-length"], String(bytes));
		assert.equal(head.bytes.length, 0, "HEAD must not send a body");

		const cached = await callHost(
			wallpapers,
			makeRequest({ url: `${WALLPAPER_PATH}/whale-sunset.jpg`, method: "GET", headers: { "if-none-match": res.headers.etag } })
		);
		assert.equal(cached.status, 304);
		assert.equal(cached.bytes.length, 0);
	});
});

test("the illustration route refuses every name the package does not ship", async () => {
	await withTempHome(async () => {
		const { wallpapers } = await mount({});
		const refused = [
			`${WALLPAPER_PATH}/../package.json`,
			`${WALLPAPER_PATH}/..%2fpackage.json`,
			`${WALLPAPER_PATH}/whale-sunset.jpg/extra`,
			`${WALLPAPER_PATH}/WHALE-SUNSET.jpg`,
			`${WALLPAPER_PATH}/whale-sunset.svg`,
			WALLPAPER_PATH,
			`${WALLPAPER_PATH}/`
		];
		for (const url of refused) {
			const res = await callHost(wallpapers, makeRequest({ url, method: "GET" }));
			assert.equal(res.status, 404, `${url} should not be served`);
		}
		const wrongMethod = await callHost(wallpapers, makeRequest({ url: `${WALLPAPER_PATH}/whale-sunset.jpg`, method: "POST" }));
		assert.equal(wrongMethod.status, 405);
	});
});

// ── hardening: the things that only fail in production ────────────────────

test("a 401 and a 403 are distinguishable in the body, not only in the status line", async () => {
	const unauth = await mount({ connection: { requestRejection: () => 401 } });
	const unauthRes = await callHost(unauth.route, makeRequest({}), PING);
	assert.equal(unauthRes.status, 401);
	assert.equal(JSON.parse(unauthRes.body).error.code, "unauthorized", "a client branching on `code` would be misled by `forbidden`");

	const forbidden = await mount({ connection: { requestRejection: () => 403 } });
	const forbiddenRes = await callHost(forbidden.route, makeRequest({}), PING);
	assert.equal(forbiddenRes.status, 403);
	assert.equal(JSON.parse(forbiddenRes.body).error.code, "forbidden");
});

test("a callable connection service still counts as present", async () => {
	// The host reads the service with `Reflect.get` and no type check. A fence
	// that demanded a plain object would drop layer two on a build that exposed
	// the service as a function, and then report it as missing — exactly
	// backwards from the truth.
	const service = Object.assign(() => {}, { requestRejection: () => 401 });
	const built = makeContext({ connection: service });
	const host = await freshHost();
	const warnings = captureWarnings(() => {
		host.apply(built.ctx);
	});
	assert.deepEqual(warnings, [], "a service that IS present must not be announced as missing");
	const route = built.routes.find((entry) => entry.path === ROUTE_PATH);
	assert.equal((await callHost(route, makeRequest({}), PING)).status, 401, "layer two must still be consulted");
});

test("an abandoned staging file is swept on the next upload, a live one is spared", async () => {
	await withTempHome(async (dir) => {
		const { splash } = await mount({});
		const mediaDir = path.join(dir, "lumen-media");
		fs.mkdirSync(mediaDir, { recursive: true });
		const stale = path.join(mediaDir, "media-old-00000000.mp4.part");
		const live = path.join(mediaDir, "media-new-11111111.mp4.part");
		fs.writeFileSync(stale, "x");
		fs.writeFileSync(live, "x");
		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

		await uploadPng(splash);
		assert.ok(!fs.existsSync(stale), "residue from a process that died mid-upload must be cleaned up");
		assert.ok(fs.existsSync(live), "a staging file young enough to be an upload in flight must survive the sweep");
	});
});

test("a cover memo is not trusted across this process's own write, even with an unchanged stamp", async () => {
	await withTempHome(async (dir) => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		// Pin the document's timestamp to a whole second, so the two reads below
		// produce a byte-identical memo key and only the explicit invalidation can
		// save us. Without this the test passes for the wrong reason: the two
		// uploads are milliseconds apart, so `mtimeMs` differs on its own and the
		// cache would miss anyway.
		const document = path.join(dir, "lumen.json");
		const pinned = Math.floor(Date.now() / 1000) - 60;
		fs.utimesSync(document, pinned, pinned);

		const asImage = [];
		inject[0](asImage);
		assert.ok(asImage.find((row) => row.kind === "style").text.includes("background-image"));

		const video = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": "video/mp4" } }), PNG);
		assert.equal(video.status, 200);
		fs.utimesSync(document, pinned, pinned);
		assert.equal(fs.statSync(document).mtimeMs, pinned * 1000, "the test only means anything if the memo key is genuinely unchanged");

		const asVideo = [];
		inject[0](asVideo);
		assert.ok(
			!asVideo.find((row) => row.kind === "style").text.includes("background-image"),
			"our own write must invalidate the memo outright, not lean on filesystem timestamp resolution"
		);
	});
});

test("the cover reflects the media kind on the very next index, with no restart", async () => {
	await withTempHome(async () => {
		const { splash, inject } = await mount({});
		await uploadPng(splash);
		const asImage = [];
		inject[0](asImage);
		assert.ok(asImage.find((row) => row.kind === "style").text.includes("background-image"));

		const video = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": "video/mp4" } }), PNG);
		assert.equal(video.status, 200);
		const asVideo = [];
		inject[0](asVideo);
		assert.ok(!asVideo.find((row) => row.kind === "style").text.includes("background-image"));
	});
});

test("a client that hangs up mid-stream is handled, not thrown", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		await uploadPng(splash);
		const res = makeResponse();
		const pending = splash.handler(makeRequest({ url: MEDIA_PATH, method: "GET" }), res);
		res.destroy();
		// `pipe` would have left the source readable open here and emitted an
		// unhandled error; `pipeline` tears both ends down. The assertion that
		// matters is that this await does not reject.
		await pending;
		assert.ok(res.destroyed);
	});
});

// ── the media table the two halves share ───────────────────────────────────
//
// The one contract in this plugin that is written down twice, in two files, in
// two languages' worth of idiom: the host decides what it will store, and the
// browser half decides what it will offer. A disagreement either way is a real
// bug and both directions are silent — a type the browser offers and the host
// refuses is a file the user can pick and cannot use, and a type the host
// accepts and the browser never offers is a feature nobody can reach.

test("the browser half offers exactly the media types the host accepts", async () => {
	await withTempHome(async () => {
		const { splash } = await mount({});
		const client = require("../src/splash.cjs");
		const offered = Array.from(client.ACCEPTED_TYPES.keys()).sort();

		// Host side, behaviourally: go through the real route for every type the
		// browser half advertises and refuse to accept a 415.
		for (const type of offered) {
			const res = await callHost(splash, makeRequest({ url: UPLOAD_PATH, headers: { "content-type": type } }), PNG);
			assert.notEqual(res.status, 415, `the browser half offers ${type}, which the host refuses`);
			assert.equal(res.status, 200, `uploading ${type} failed: ${res.body}`);
		}

		// And the other direction, from the host's own table. Read out of the
		// source rather than exported, deliberately: the thing being watched is a
		// change to that table, and an export for the test to read would be one
		// more artefact to keep in step with the table itself.
		const source = fs.readFileSync(path.join(__dirname, "..", "lib", "index.js"), "utf8");
		const start = source.indexOf("const MEDIA_TYPES");
		assert.ok(start !== -1, "the host's media table is no longer called MEDIA_TYPES");
		const block = source.slice(start, source.indexOf("]);", start));
		const accepted = Array.from(new Set(Array.from(block.matchAll(/"(?:image|video)\/[a-z0-9+.-]+"/g)).map((match) => match[0].slice(1, -1)))).sort();
		assert.ok(accepted.length >= 6, `only ${accepted.length} types were read out of the host's table; the parse is probably stale`);
		assert.deepEqual(offered, accepted, "the two halves disagree about what a splash may be");
	});
});
