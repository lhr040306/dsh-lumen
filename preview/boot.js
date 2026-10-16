/**
 * Boot the shipped bundle on the shell-index stand-in.
 *
 * WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE
 *
 * `preview/preview.js` boots the plugin too, and this file deliberately does not
 * reuse it: that one mounts the settings panel, drives the diagnostics and needs
 * forty-odd elements in the page to exist. This one does the single thing the
 * shell does — build a context, call `apply`, and hand `#root` over to the app —
 * and then gets out of the way.
 *
 * It is here rather than inline in `boot.html` because it has one job that has
 * to be *timed* right, and timing is easier to read as code than as markup.
 *
 * THE HANDOFF
 *
 * The host's own `mountApp` finds a `:scope > [data-dsh-boot]` inside the root
 * container and hydrates it through `BootHandoff`, which renders the framework-
 * free boot kernel for one commit and then replaces it with the app. Everything
 * downstream of that — the splash cover's release, in particular — is timed
 * against the marker appearing and then going away, so this page has to produce
 * the same two moments. It does: the kernel is in the document from the first
 * parse, and this file swaps it for the app tree two frames later.
 *
 * Two frames rather than one, for a reason that is easy to get wrong: a
 * `requestAnimationFrame` callback runs BEFORE the paint it belongs to, so
 * swapping inside the first callback would remove the kernel without it ever
 * having been on screen. The real handoff shows it. So does this one.
 */

(function () {
	"use strict";

	const preview = window.__DSH_LUMEN_PREVIEW__;
	const root = document.getElementById("root");
	const template = document.getElementById("shell-app");

	/**
	 * One line of outcome in the bottom bar.
	 *
	 * The bar lives inside the template, so it does not exist until the handoff
	 * has happened — which is fine, because everything worth saying here happens
	 * after that. A call that arrives too early is dropped rather than queued:
	 * the message would be stale by the time there was somewhere to put it.
	 */
	function say(text) {
		const node = document.getElementById("boot-status");
		if (node !== null) node.textContent = text;
	}

	function handOver(bootPresent) {
		if (template !== null) root.replaceChildren(template.content.cloneNode(true));
		say(bootPresent ? "外壳已接管 · data-dsh-boot 已移除" : "无 boot 内核 · 直接渲染");
	}

	if (preview === undefined || preview === null || root === null) {
		// Nothing to say anywhere: the bar does not exist yet. The console is the
		// only surface left, and a missing harness is a page-level problem rather
		// than a plugin one.
		try {
			console.error("[boot] harness or #root missing; the stand-in cannot boot");
		} catch {}
		return;
	}

	const ctx = preview.createContext();
	ctx.theme.mount(document.documentElement);

	let api = null;
	try {
		api = preview.module("dsh-lumen").apply(ctx);
	} catch (error) {
		// The browser half is written never to throw, so reaching here means the
		// harness is at fault. Say so, and still hand the shell over — a stand-in
		// that shows nothing at all teaches nobody anything.
		try {
			console.error("[boot] apply threw:", error);
		} catch {}
		handOver(false);
		return;
	}

	const boot = root.querySelector("[data-dsh-boot]");
	if (boot === null) {
		// The marker is already gone, which is the other legal shape: a host
		// without the boot kernel renders the app straight into the container.
		handOver(false);
	} else {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				handOver(root.querySelector("[data-dsh-boot]") !== null);
			});
		});
	}

	/** The same handle `preview.js` publishes, for the same reason: inspection. */
	window.__DSH_LUMEN_BOOT__ = { api, ctx, root };
})();
