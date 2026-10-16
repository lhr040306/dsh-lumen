"use strict";
/**
 * The preview server.
 *
 * WHY THIS EXISTS RATHER THAN `python -m http.server`
 *
 * The browser half talks to a fenced JSON route (`POST /lumen/api`) on its own
 * origin. A plain static server would make that route 404, `store.getHealth()`
 * would report `no-fetch`, and the preview would exercise the *degraded* path
 * only — which is the least interesting half of the plugin.
 *
 * WHY IT MOUNTS THE REAL HOST MODULE INSTEAD OF RE-IMPLEMENTING IT
 *
 * This file used to carry its own copy of the state file reader, the merge
 * rules and the route. It was a good copy, and it was still a copy: two
 * implementations of one contract, kept in step by nothing but care. That is
 * not a theoretical objection. The host half's own deletion path was found
 * deleting a key it did not model, and the mirror here would have gone on
 * agreeing with the *old* behaviour — the preview would have shown a merge
 * working exactly as the buggy host half did, which is worse than showing
 * nothing.
 *
 * So the preview does not describe the host contract. It *mounts the host
 * half*: `lib/index.js` is imported, given a small platform context, and
 * `apply()` registers its real routes. Everything the page talks to is the
 * shipped code — same merger, same ceilings, same fence, same splash routes.
 * What is faked is only what a browser tab cannot supply: a web server, a
 * runtime, and a connection gate.
 *
 * The one thing the fake decides is WHERE state lands. `lib/index.js` resolves
 * its paths from `$DSH_HOME`, so this file points that variable at
 * `preview/.state/` *before* importing it. The preview therefore cannot write
 * to the user's real profile — not because it declines to, but because the
 * only path the host half can compute leads into the repo.
 *
 * WHY IT ALSO APPLIES THE INJECTED ROWS
 *
 * The host half's splash cover is not a DOM interaction, it is two rows pushed
 * into the shell's `webserver/index-inject` table. A preview that served plain
 * files would leave the entire feature unobservable — you could set a splash
 * and never see it. So the server keeps the injected table, and splices it into
 * any document that declares itself a stand-in for the shell's index (see
 * {@link SHELL_DOCUMENT_MARKER}). The rows are the plugin's own; this file only
 * decides where they go.
 *
 * Zero dependencies: `node:http` and nothing else, so `npm run preview` works on
 * a fresh checkout with no install step.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
/** The host half, mounted rather than imitated. */
const HOST_MODULE = path.join(ROOT, "lib", "index.js");
/** Default `$DSH_HOME` for a preview run. Inside the repo, so the real one is untouched. */
const DEFAULT_STATE_FILE = path.join(ROOT, "preview", ".state", "lumen.json");
/** The event the shell uses to collect extra rows for the document it serves. */
const INJECT_EVENT = "webserver/index-inject";
/**
 * Marks a served document as a stand-in for the shell's index.
 *
 * The cover's main rule is `#root{visibility:hidden}` — it targets the shell's
 * own root node. The preview's main page is not the shell's document and has no
 * such node, so injecting the cover into it would add a stylesheet that hides
 * nothing while painting a full-bleed splash behind the preview chrome. The
 * declaration is therefore explicit and per-document: `boot.html` carries it,
 * `index.html` does not, and neither has to guess about the other.
 */
const SHELL_DOCUMENT_MARKER = "data-dsh-lumen-shell-document";
/** Port range tried in order when the preferred one is taken. */
const PORT_PROBE_LIMIT = 12;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8"
};

/** Parse `--flag value` / `--flag=value` pairs; boolean flags map to `true`. */
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token.slice(0, 2) !== "--") continue;
		const eq = token.indexOf("=");
		if (eq !== -1) {
			out[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const name = token.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && next.slice(0, 2) !== "--") {
			out[name] = next;
			i += 1;
		} else {
			out[name] = true;
		}
	}
	return out;
}

// ── injected rows ──────────────────────────────────────────────────────────

/**
 * One injected row as HTML.
 *
 * Only the two kinds this plugin actually emits are understood, and anything
 * else throws. That is deliberate: a preview that quietly skipped a row kind it
 * did not recognise would serve a page that differs from the shell's while
 * looking like it agreed with it — the failure mode this whole file exists to
 * remove. An unknown kind should be a loud 500 the moment somebody adds one.
 */
function rowMarkup(row) {
	if (row === null || typeof row !== "object") throw new TypeError("an injected row must be an object");
	if (row.kind === "style") {
		if (typeof row.text !== "string") throw new TypeError("an injected style row must carry text");
		return `<style>${row.text}</style>`;
	}
	if (row.kind === "script") {
		const placement = row.placement === undefined ? "head" : row.placement;
		if (placement !== "head") throw new Error(`the preview cannot inject a script at ${JSON.stringify(placement)}`);
		if (typeof row.text !== "string") throw new TypeError("an injected script row must carry text");
		return `<script>${row.text}</script>`;
	}
	throw new Error(`the preview does not know how to serve an injected row of kind ${JSON.stringify(row.kind)}`);
}

/**
 * Splice the injected rows into a document, at the end of its head.
 *
 * Returns the document unchanged when there is nothing to inject, or when the
 * document has not declared itself the shell's index. The order the rows
 * arrived in is kept: a stylesheet and the guard script that removes it must be
 * evaluated in that order, and reordering them would be a real behaviour change
 * dressed up as tidiness.
 */
function applyInjections(html, rows) {
	if (typeof html !== "string") throw new TypeError("applyInjections expects the document text");
	if (!Array.isArray(rows) || rows.length === 0) return html;
	if (html.indexOf(SHELL_DOCUMENT_MARKER) === -1) return html;
	const head = html.indexOf("</head>");
	if (head === -1) throw new Error(`a document marked ${SHELL_DOCUMENT_MARKER} has no </head> to inject into`);
	return `${html.slice(0, head)}\n${rows.map(rowMarkup).join("\n")}\n${html.slice(head)}`;
}

// ── the fake platform ──────────────────────────────────────────────────────

/** Whether a request names the local loopback authority, and is not cross-site. */
function isLoopbackRequest(req) {
	const host = typeof req.headers.host === "string" ? req.headers.host : "";
	let hostname = "";
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	if (hostname !== "localhost" && hostname !== "[::1]") {
		const parts = hostname.split(".");
		if (!(parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255))) return false;
	}
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	return true;
}

/**
 * The context the real host half is mounted on.
 *
 * Four services, and every one of them is a shape the host half already probes
 * for rather than demands:
 *
 *   - `webServer.register` collects the routes. The host half registers two
 *     prefixes; the preview matches a request against them and hands it over.
 *   - `webRuntime.trustedHosts` stays empty. This server binds loopback and
 *     nothing else, and an empty list is what makes layer one of the fence
 *     refuse every other authority rather than trust one.
 *   - `connection.requestRejection` is the one place the preview makes a
 *     judgement of its own, and it is the smallest one possible: answer the
 *     host's own verdict for a local, same-origin request, which is `undefined`.
 *     A preview has no browser session to authenticate, so the `401` branch of
 *     the real gate cannot arise here at all — `tests/host.test.cjs` covers that
 *     branch with a double that can construct it, and this file does not
 *     pretend otherwise.
 *   - `on` / `effect` behave as cordis does: listeners are collected, effects
 *     run immediately and are unwound in reverse on dispose.
 *
 * `effectLabels()` exists so a test can prove the host half registered both of
 * its routes through `effect` rather than merely calling `register`.
 */
function createHostContext() {
	const routes = [];
	const injectHandlers = [];
	const effects = [];
	const listeners = new Map();

	function remove(list, item) {
		const index = list.indexOf(item);
		if (index !== -1) list.splice(index, 1);
	}

	const ctx = {
		webServer: {
			register(route) {
				if (route === null || typeof route !== "object" || typeof route.handler !== "function") {
					throw new TypeError("webServer.register expects { kind, path, handler }");
				}
				const entry = { kind: route.kind, path: String(route.path), handler: route.handler };
				routes.push(entry);
				return () => remove(routes, entry);
			}
		},
		webRuntime: { trustedHosts: [] },
		connection: {
			requestRejection(req) {
				return isLoopbackRequest(req) ? undefined : 403;
			}
		},
		on(name, listener) {
			if (typeof listener !== "function") return () => {};
			const set = listeners.get(name) || new Set();
			set.add(listener);
			listeners.set(name, set);
			if (name === INJECT_EVENT) injectHandlers.push(listener);
			return () => {
				set.delete(listener);
				remove(injectHandlers, listener);
			};
		},
		effect(run, label) {
			const result = run();
			effects.push({ dispose: typeof result === "function" ? result : null, label: label || "(unlabelled)" });
			return result;
		},
		dispose() {
			for (let i = effects.length - 1; i >= 0; i -= 1) {
				try {
					if (typeof effects[i].dispose === "function") effects[i].dispose();
				} catch (error) {
					process.stderr.write(`preview: effect ${effects[i].label} failed to dispose: ${error && error.message}\n`);
				}
			}
			effects.length = 0;
			listeners.clear();
			injectHandlers.length = 0;
		}
	};

	return {
		ctx,
		routes,
		effectLabels: () => effects.map((effect) => effect.label),
		/**
		 * Run every index-inject handler and return the rows they contributed.
		 *
		 * A handler that throws is logged and skipped rather than allowed to fail
		 * the page: the host half's own handler cannot throw, and a preview that
		 * returned nothing because of a third party would be a worse failure than
		 * one that returned an uninjected document.
		 */
		collectRows() {
			const table = [];
			for (const handler of injectHandlers) {
				try {
					handler(table);
				} catch (error) {
					process.stderr.write(`preview: an index-inject handler threw: ${error && error.message}\n`);
				}
			}
			return table;
		},
		dispose: () => ctx.dispose()
	};
}

/** The first registered route whose prefix covers a path, or `null`. */
function matchingRoute(urlPath, routes) {
	for (const route of routes) {
		if (route.path === urlPath || urlPath.startsWith(`${route.path}/`)) return route;
	}
	return null;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function writeJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

function fail(res, status, code, message) {
	writeJson(res, status, { ok: false, error: { code, message } });
}

/**
 * Resolve a URL path to a file inside ROOT, or `null` when it escapes.
 */
function resolveStatic(urlPath) {
	let decoded = urlPath;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	if (decoded.indexOf("\0") !== -1) return null;
	const relative = decoded === "/" ? "preview/index.html" : decoded.replace(/^\/+/, "");
	const full = path.resolve(ROOT, relative);
	const prefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
	if (full !== ROOT && !full.startsWith(prefix)) return null;
	return full;
}

/** Serve one file, applying the injected rows to a document that asked for them. */
function sendFile(res, full, stat, rows) {
	const extension = path.extname(full).toLowerCase();
	const type = MIME[extension] || "application/octet-stream";
	if (extension !== ".html" && extension !== ".htm") {
		res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "no-store" });
		fs.createReadStream(full).pipe(res);
		return;
	}
	let body;
	try {
		body = applyInjections(fs.readFileSync(full, "utf8"), rows);
	} catch (error) {
		// A row the preview cannot serve, or a document it cannot inject into.
		// Loud, and visible on the page, rather than a quietly unbranded document.
		fail(res, 500, "injection-failed", String(error && error.message));
		return;
	}
	const buffer = Buffer.from(body, "utf8");
	res.writeHead(200, { "content-type": type, "content-length": buffer.length, "cache-control": "no-store" });
	res.end(buffer);
}

function serveStatic(req, res, urlPath, collectRows) {
	// The preview is a *directory* page: `preview/index.html` pulls in
	// `./harness.js`, `./shell.css` and `../lib/client.js`, and a browser resolves
	// those against the document URL. Serving the same file at `/` would make
	// every relative reference resolve one level too high, so the root is a
	// redirect rather than an alias.
	if (urlPath === "/") {
		res.writeHead(302, { location: "/preview/", "cache-control": "no-store" });
		res.end();
		return;
	}
	const full = resolveStatic(urlPath);
	if (full === null) {
		fail(res, 403, "forbidden", "path escapes the served root");
		return;
	}
	let stat = null;
	try {
		stat = fs.statSync(full);
	} catch {
		stat = null;
	}
	if (stat !== null && stat.isDirectory()) {
		// A directory reached *without* its trailing slash has to be redirected
		// first: the browser would otherwise keep `/preview` as the document URL
		// and resolve `./harness.js` against `/`, one level too high.
		if (!urlPath.endsWith("/")) {
			res.writeHead(301, { location: `${urlPath}/`, "cache-control": "no-store" });
			res.end();
			return;
		}
		serveStatic(req, res, `${urlPath}index.html`, collectRows);
		return;
	}
	if (stat === null) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`404 — not found: ${urlPath}\n`);
		return;
	}
	sendFile(res, full, stat, collectRows());
}

// ── main ───────────────────────────────────────────────────────────────────

/**
 * Bring up the preview.
 *
 * `$DSH_HOME` is pinned before the host module is imported. The host half reads
 * it on every call rather than at load, so either order would work — but pinning
 * first means there is no instant in this process's life at which a failed
 * import could have resolved a path into the user's real profile.
 */
async function main() {
	const args = parseArgs(process.argv.slice(2));
	const host = typeof args.host === "string" ? args.host : "127.0.0.1";
	const stateFile = typeof args.state === "string" ? path.resolve(args.state) : DEFAULT_STATE_FILE;
	const expectedName = path.basename(DEFAULT_STATE_FILE);
	if (path.basename(stateFile) !== expectedName) {
		process.stderr.write(`--state must point at a file named ${expectedName}: the host half fixes that name inside $DSH_HOME\n`);
		process.exit(2);
	}
	const stateDir = path.dirname(stateFile);
	process.env.DSH_HOME = stateDir;

	const mediaDir = path.join(stateDir, "lumen-media");
	if (args.reset === true) {
		const removed = [stateFile];
		try {
			fs.rmSync(stateFile, { force: true });
		} catch {}
		// The cover is chosen by the state file, which is now gone, so leaving the
		// bytes behind would be inert — but they would also be unreachable, and a
		// `--reset` that leaves half a demo on disk is not a reset. Guarded on the
		// directory name so a `--state` pointing somewhere unexpected can only ever
		// have its own `lumen-media` removed.
		if (path.basename(mediaDir) === "lumen-media") {
			try {
				fs.rmSync(mediaDir, { recursive: true, force: true });
				removed.push(mediaDir);
			} catch {}
		}
		process.stdout.write(`reset: removed ${removed.join(", ")}\n`);
	}

	const preferred = Number.isFinite(Number(args.port)) && args.port !== undefined ? Number(args.port) : 4173;

	const hostModule = await import(pathToFileURL(HOST_MODULE).href);
	if (typeof hostModule.apply !== "function") throw new TypeError(`${HOST_MODULE} does not export apply()`);
	const bridge = createHostContext();
	// The real thing. Both of its routes, its own fence, its own merger.
	hostModule.apply(bridge.ctx);
	if (bridge.routes.length === 0) {
		throw new Error(`${path.basename(HOST_MODULE)} registered no routes; the preview would serve a plugin it cannot reach`);
	}

	const server = http.createServer((req, res) => {
		let urlPath = "/";
		try {
			urlPath = new URL(req.url, "http://localhost").pathname;
		} catch {
			fail(res, 400, "bad-request", "bad request");
			return;
		}
		// One gate for everything, static files included. A preview server hands
		// out the working tree, and a rebinding hostname is the one way a page in
		// somebody else's tab reaches a loopback socket.
		if (!isLoopbackRequest(req)) {
			fail(res, 403, "forbidden", "forbidden");
			return;
		}
		const route = matchingRoute(urlPath, bridge.routes);
		if (route !== null) {
			// Straight to the plugin's handler, with no pre-dispatch check of our
			// own. The real host would admit before routing, and if the preview did
			// the same, the plugin's own three-layer fence could never be the thing
			// that refused — and being able to watch *that* refuse is most of the
			// reason to run the real half here at all.
			Promise.resolve()
				.then(() => route.handler(req, res))
				.catch((error) => {
					process.stderr.write(`preview: ${route.path} handler threw: ${error && error.message}\n`);
					if (res.headersSent) {
						try {
							res.end();
						} catch {}
						return;
					}
					fail(res, 500, "internal", "internal error");
				});
			return;
		}
		serveStatic(req, res, urlPath, () => bridge.collectRows());
	});

	// The preferred port is only a preference: a second preview window (or an
	// unrelated dev server) should not be a startup failure, so walk forward.
	let attempts = 0;
	server.on("error", (error) => {
		if (error && error.code === "EADDRINUSE" && attempts < PORT_PROBE_LIMIT) {
			attempts += 1;
			server.listen(preferred + attempts, host);
			return;
		}
		process.stderr.write(`preview server failed: ${error && error.message}\n`);
		process.exit(1);
	});

	server.listen(preferred, host, () => {
		const port = server.address().port;
		process.stdout.write(
			[
				"dsh-lumen preview",
				`  url         http://${host}:${port}/preview/`,
				`  shell index http://${host}:${port}/preview/boot.html`,
				`  root        ${ROOT}`,
				`  state dir   ${stateDir}`,
				`  host half   ${path.basename(HOST_MODULE)} mounted, ${bridge.routes.length} routes`,
				"",
				`The routes are the plugin's own, not a copy. It resolves DSH_HOME to`,
				`${stateDir} for this process, so nothing here reaches the real profile.`,
				"Press Ctrl+C to stop."
			].join("\n") + "\n"
		);
	});
}

module.exports = { applyInjections, rowMarkup, resolveStatic, isLoopbackRequest, matchingRoute, createHostContext, parseArgs, DEFAULT_STATE_FILE, SHELL_DOCUMENT_MARKER };

if (require.main === module) {
	main().catch((error) => {
		process.stderr.write(`preview server failed: ${error && error.stack ? error.stack : error}\n`);
		process.exit(1);
	});
}
