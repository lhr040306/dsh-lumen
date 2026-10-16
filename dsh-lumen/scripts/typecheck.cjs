"use strict";
/**
 * Static consistency checks for the package as a *package*.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TESTS
 *
 * The test suite proves the modules behave. It cannot prove that the modules
 * are wired to each other correctly, because a wiring mistake is usually a
 * *load-time* failure in a place nothing loads. The bug that motivated this file
 * was exactly that: `src/index.cjs` required `./panel.cjs` while the file lived
 * at `./ui/panel.cjs`. Every unit test passed; in the shell, the plugin did
 * nothing at all, because the entry factory threw before `apply` was reached.
 *
 * So this checks the seams:
 *
 *   1. every relative `require` resolves to a file that exists;
 *   2. every destructured import names something the target module exports;
 *   3. the four places the plugin id and paths are written agree with each other
 *      (`package.json`, `cordis.patch.yml`, `src/index.cjs`, `lib/index.js`);
 *   4. the generated locale files match the translation table;
 *   5. every source file parses.
 *
 * It is deliberately dependency-free: it is meant to run on a bare checkout,
 * like the tests.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const LOCALE = path.join(ROOT, "locale");

const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);
const rel = (full) => path.relative(ROOT, full).split(path.sep).join("/");

/** Every `.cjs` file under a directory. */
function collect(dir, extension) {
	const suffix = extension || ".cjs";
	const out = [];
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(suffix)) out.push(full);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out.sort();
}

/** Strip comments and string literals so pattern scans do not match prose. */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

// ── 1 & 2: requires resolve, and named imports exist ─────────────────────────

/** Resolve a CJS `require` specifier the way Node's resolver would, for `./`/`../` only. */
function resolveRelative(fromFile, spec) {
	if (spec.charAt(0) !== ".") return null;
	const base = path.resolve(path.dirname(fromFile), spec);
	for (const candidate of [base, `${base}.cjs`, path.join(base, "index.cjs")]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

const sourceFiles = collect(SRC);

for (const file of sourceFiles) {
	const source = fs.readFileSync(file, "utf8");
	const code = stripComments(source);
	const where = rel(file);

	// Syntax.
	try {
		new vm.Script(source, { filename: file });
	} catch (error) {
		fail(`${where}: does not parse — ${error.message}`);
		continue;
	}

	// `const { a, b } = require("./x.cjs")`
	const destructured = /const\s*\{([^}]+)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of code.matchAll(destructured)) {
		const names = match[1]
			.split(",")
			.map((part) => {
				// `{ exported }`, `{ exported: local }` and `{ exported = fallback }`
				// all *import* the first name; the rest is local naming, and checking
				// it against the target's exports would be a false positive.
				const [imported] = part.split(/[:=]/);
				return imported.trim();
			})
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
		const spec = match[2];
		const target = resolveRelative(file, spec);
		if (target === null) {
			if (spec.charAt(0) === ".") fail(`${where}: requires "${spec}", which does not exist`);
			continue;
		}
		const targetCode = stripComments(fs.readFileSync(target, "utf8"));
		const exportsBlock = targetCode.slice(targetCode.indexOf("module.exports"));
		if (exportsBlock.length === 0) {
			fail(`${where}: requires "${spec}", which has no module.exports`);
			continue;
		}
		for (const name of names) {
			// `module.exports = { a, b }` and `module.exports = { a: b }` both count.
			const pattern = new RegExp(`[{,\\s]${name}\\s*[,:}]`);
			if (!pattern.test(exportsBlock)) {
				fail(`${where}: imports ${name} from "${spec}", but ${rel(target)} does not export it`);
			}
		}
	}

	// Bare `require("./x.cjs")` with no destructuring must still resolve.
	const bare = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
	for (const match of code.matchAll(bare)) {
		if (resolveRelative(file, match[1]) === null) {
			fail(`${where}: requires "${match[1]}", which does not exist`);
		}
	}
}

// ── 3: the plugin id and the shared paths agree ──────────────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const patchPath = path.join(ROOT, "cordis.patch.yml");
const patch = fs.readFileSync(patchPath, "utf8");
const entry = fs.readFileSync(path.join(SRC, "index.cjs"), "utf8");
const host = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

const patchName = (patch.match(/name:\s*['"]?([^'"\s]+)['"]?/) || [])[1];
if (patchName !== manifest.name) {
	fail(`cordis.patch.yml inserts "${patchName}" but package.json is named "${manifest.name}"`);
}
if (patch.indexOf("insert:") < 0) fail("cordis.patch.yml has no insert: entry");

const entryApiPath = (entry.match(/const API_PATH\s*=\s*["']([^"']+)["']/) || [])[1];
const hostApiPrefix = (host.match(/const API_PREFIX\s*=\s*["']([^"']+)["']/) || [])[1];
if (entryApiPath === undefined) fail("src/index.cjs declares no API_PATH");
if (hostApiPrefix === undefined) fail("lib/index.js declares no API_PREFIX");
if (entryApiPath !== undefined && hostApiPrefix !== undefined && entryApiPath !== hostApiPrefix) {
	fail(`the two halves disagree on the API route: client "${entryApiPath}" vs host "${hostApiPrefix}"`);
}

const hostName = (host.match(/export const name\s*=\s*["']([^"']+)["']/) || [])[1];
if (hostName !== manifest.name) {
	fail(`lib/index.js exports name="${hostName}" but package.json is named "${manifest.name}"`);
}

if (manifest.dsh === undefined) fail("package.json has no dsh manifest block");
else {
	const bundlePatch = manifest.dsh.bundle && manifest.dsh.bundle.patch;
	if (typeof bundlePatch !== "string" || !fs.existsSync(path.join(ROOT, bundlePatch))) {
		fail(`dsh.bundle.patch points at "${bundlePatch}", which does not exist`);
	}
	const injected = (manifest.dsh.client && manifest.dsh.client.inject) || [];
	if (injected.length === 0) fail("dsh.client.inject is empty; the browser half would load with no services");
	// Every injected seed must also be declared, or the loader's ordering promise
	// is a claim the package does not make anywhere else.
	const declared = Object.keys(manifest.peerDependencies || {});
	for (const seed of injected) {
		if (!declared.includes(seed)) fail(`dsh.client.inject lists "${seed}", which is not a peerDependency`);
	}
	if (manifest.dsh.client.platform === undefined) fail("dsh.client.platform is not declared");
}

// Files advertised but absent are a packaging bug: npm ships a hollow package.
for (const pattern of manifest.files || []) {
	// Only literal paths can be checked; a glob is checked by its directory part.
	const literal = pattern.replace(/\/\*\*?.*$/, "");
	if (literal.length === 0) continue;
	if (!fs.existsSync(path.join(ROOT, literal))) fail(`package.json "files" lists "${pattern}", which does not exist`);
}

// ── 4: the generated locale files match the table ────────────────────────────

const i18nSource = fs.readFileSync(path.join(SRC, "i18n.cjs"), "utf8");
const tableBlock = i18nSource.slice(i18nSource.indexOf("const TABLE"), i18nSource.indexOf("/**", i18nSource.indexOf("const TABLE")));
const pairs = Array.from(tableBlock.matchAll(/"([^"]+)":\s*\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g));
if (pairs.length < 50) fail(`only ${pairs.length} translation pairs were parsed out of src/i18n.cjs`);

const namespace = (i18nSource.match(/const NS\s*=\s*["']([^"']+)["']/) || [])[1];
if (namespace === undefined) fail("src/i18n.cjs declares no NS");

for (const [lang, column] of [["zh", 1], ["en", 2]]) {
	const file = path.join(LOCALE, `${lang}.json`);
	const expected = {};
	for (const [, key, zh, en] of pairs) expected[key] = column === 1 ? zh : en;
	const serialised = `${JSON.stringify(expected, null, "\t")}\n`;
	if (!fs.existsSync(file)) {
		fail(`locale/${lang}.json is missing — run npm run build`);
		continue;
	}
	const actual = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	if (actual !== serialised) {
		fail(`locale/${lang}.json is out of date with src/i18n.cjs — run npm run build`);
	}
}
note(`${pairs.length} translation keys in namespace "${namespace}"`);

// ── 5: the shipped bundle is present and matches its source ──────────────────

const bundleFile = path.join(ROOT, "lib", "client.js");
if (!fs.existsSync(bundleFile)) {
	fail("lib/client.js is missing — run npm run build");
} else {
	const bundle = fs.readFileSync(bundleFile, "utf8");
	if (bundle.indexOf("__ModuleLoader__.load") < 0) fail("lib/client.js does not use the module-loader contract");
	// A module in `src` that never made it into the bundle is a file that will
	// never run in the shell.
	for (const file of sourceFiles) {
		const id = rel(file);
		if (id === "src/index.cjs") continue;
		if (bundle.indexOf(`//#region ${id}`) < 0) fail(`lib/client.js does not contain ${id} — run npm run build`);
	}
}

// ── 6: the declaration files describe what actually exists ───────────────────

/** Names a `.d.ts` declares as exported values (not types or interfaces). */
function declaredValues(source) {
	return Array.from(source.matchAll(/export declare (?:const|function)\s+([A-Za-z_$][\w$]*)/g)).map((m) => m[1]).sort();
}

/** Names an ESM module exports as values. */
function moduleValues(source) {
	return Array.from(source.matchAll(/export (?:const|function|async function)\s+([A-Za-z_$][\w$]*)/g)).map((m) => m[1]).sort();
}

// Host half.
const hostTypesPath = path.join(ROOT, "lib", "types", "index.d.ts");
if (!fs.existsSync(hostTypesPath)) {
	fail("lib/types/index.d.ts is missing (package.json points `types` at it)");
} else {
	const declared = declaredValues(fs.readFileSync(hostTypesPath, "utf8"));
	const real = moduleValues(host);
	const missing = real.filter((name) => !declared.includes(name));
	if (missing.length > 0) fail(`lib/types/index.d.ts does not declare: ${missing.join(", ")}`);
	const extra = declared.filter((name) => !real.includes(name));
	if (extra.length > 0) fail(`lib/types/index.d.ts declares ${extra.join(", ")}, which lib/index.js does not export`);
}

// Browser half: the bundle's re-export list is the source of truth.
const clientTypesPath = path.join(ROOT, "lib", "client.d.ts");
const bundleSource = fs.existsSync(bundleFile) ? fs.readFileSync(bundleFile, "utf8") : "";
const exportedList = (bundleSource.match(/__exported = \[([^\]]+)\]/) || [])[1];
if (exportedList === undefined) {
	fail("lib/client.js has no __exported list — run npm run build");
} else {
	const real = Array.from(exportedList.matchAll(/"([^"]+)"/g)).map((m) => m[1]).sort();
	const entrySource = fs.readFileSync(path.join(SRC, "index.cjs"), "utf8");
	const entryBlock = entrySource.slice(entrySource.indexOf("module.exports"));
	const notExported = real.filter((name) => !new RegExp(`[{,\\s]${name}\\s*[,}]`).test(entryBlock));
	if (notExported.length > 0) {
		fail(`lib/client.js re-exports ${notExported.join(", ")}, which src/index.cjs does not export`);
	}
	if (!fs.existsSync(clientTypesPath)) {
		fail("lib/client.d.ts is missing (the ./client entry point resolves its types there)");
	} else {
		const declared = declaredValues(fs.readFileSync(clientTypesPath, "utf8").replace(/export type \{[^}]*\};/g, ""));
		const undeclared = real.filter((name) => !declared.includes(name));
		if (undeclared.length > 0) fail(`lib/client.d.ts does not declare: ${undeclared.join(", ")}`);
	}
}

// ── 7: the tooling and the preview parse, and the preview is wired up ────────

/**
 * Tooling files are checked here rather than by the test runner for the same
 * reason `src/**` is: a syntax error in `scripts/serve.cjs` or in the preview's
 * harness is invisible until someone runs that one command, and the preview in
 * particular is only ever exercised in a browser.
 */
const tooling = collect(path.join(ROOT, "scripts")).concat(collect(path.join(ROOT, "preview"), ".js"));
for (const file of tooling) {
	const where = rel(file);
	try {
		new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
	} catch (error) {
		fail(`${where}: does not parse — ${error.message}`);
	}
}

// The preview page's own references, so a renamed asset cannot silently 404 in
// the only place the page is ever opened.
const previewHtml = path.join(ROOT, "preview", "index.html");
if (!fs.existsSync(previewHtml)) {
	fail("preview/index.html is missing");
} else {
	const html = fs.readFileSync(previewHtml, "utf8");
	const refs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g)).map((match) => match[1]);
	if (refs.length < 4) fail(`only ${refs.length} references were parsed out of preview/index.html`);
	for (const ref of refs) {
		if (ref.slice(0, 4) === "http") continue;
		if (!fs.existsSync(path.resolve(path.dirname(previewHtml), ref))) {
			fail(`preview/index.html references "${ref}", which does not exist`);
		}
	}
}

// ── report ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
	process.stderr.write(`typecheck FAILED — ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
	for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
	process.exit(1);
}

process.stdout.write(`typecheck ok — ${sourceFiles.length} source files, ${tooling.length} tooling files`);
if (notes.length > 0) process.stdout.write(`, ${notes.join(", ")}`);
process.stdout.write("\n");
