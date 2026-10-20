"use strict";
/**
 * The splash's browser half.
 *
 * WHAT IT DOES, AND — MORE IMPORTANTLY — WHAT IT DELIBERATELY DOES NOT
 *
 * An image splash needs nothing here at all. The host half injects a stylesheet
 * that paints the picture on the first frame, and a guard that takes that
 * stylesheet down when the shell hands its container over to the app. Both live
 * in the document itself, so an image splash appears and gives way even if this
 * bundle never loads — which is the entire point of having a splash rather than
 * a loading screen drawn by the thing that is loading.
 *
 * A clip is the one case that cannot be done that way, because nothing in CSS
 * can play video. So this half does four things, and only for a clip:
 *
 *   1. asks the host what the splash is (`HEAD /lumen/splash/media`);
 *   2. suspends the guard's release, because the guard's idea of "ready" is the
 *      shell's boot handoff and "the shell is up" is not "a frame is on screen";
 *   3. mounts an opaque, full-viewport layer above everything and plays it;
 *   4. reveals the interface when it has a frame, and removes the layer when the
 *      clip is over.
 *
 * EVERY EXIT IS BOUNDED. A clip that will not decode, a fetch that never
 * answers, a `playing` event that never arrives — each of them ends with the
 * layer gone and the cover lifted. The suspension is *lengthened* rather than
 * cancelled, for the same reason: an outright bug in this file should cost
 * thirty seconds of splash, never a black screen with no way back.
 *
 * WHY THE LAYER GOES ON `document.body` AND NOT INSIDE `#root`
 *
 * Two independent reasons, and either one alone would settle it. The cover's
 * whole mechanism is `#root{visibility:hidden}` — anything mounted inside it
 * would be hidden by the very cover it exists to replace. And the shell marks
 * `#root` inert for its own overlays (`appRoot.inert = true`), which would take
 * the layer's own click-to-skip along with it.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * It will not play a splash when no cover was injected. The cover and the
 * splash are one decision, made when the document was generated; a page with no
 * cover is a page that was served before a splash existed. Playing a clip into
 * that page anyway would be a *second*, different decision — and a document
 * served without a cover has no black for the clip to arrive against, so the
 * user would see the interface flash and then be covered by something that is
 * not going to release. The panel says "takes effect on the next load" instead,
 * which is true.
 */

/** Route prefix the host half owns for the splash. Kept in step with `lib/index.js`. */
const SPLASH_PATH = "/lumen/splash";
const MEDIA_PATH = `${SPLASH_PATH}/media`;
const UPLOAD_PATH = `${SPLASH_PATH}/upload`;
const CLEAR_PATH = `${SPLASH_PATH}/clear`;
/** Switch back to the clip the package itself ships with. */
const BUILTIN_PATH = `${SPLASH_PATH}/builtin`;
/** The host's header naming where the current splash came from, on the media route. */
const SOURCE_HEADER = "x-lumen-splash-source";
/**
 * What this half will hand to the host, mapped to what it calls it.
 *
 * Deliberately a copy of the host's own table rather than a superset: the host
 * refuses anything outside it with a 415, so a type listed here and not there
 * would produce a round-trip that can only fail. The reverse — a type the host
 * accepts and this half filters out — would be a picture the user cannot pick,
 * which is why the list is checked against the host's in the tests rather than
 * trusted to have been copied correctly.
 */
const ACCEPTED_TYPES = new Map([
	["image/png", "image"],
	["image/jpeg", "image"],
	["image/webp", "image"],
	["image/gif", "image"],
	["image/avif", "image"],
	["video/mp4", "video"],
	["video/webm", "video"],
	["video/ogg", "video"]
]);
/** The global the injected guard publishes. Absent means no cover was injected. */
const COVER_BRIDGE = "__DSH_LUMEN_SPLASH__";
/** Attribute marking the element this half owns, so a test and a person can both find it. */
const LAYER_ATTRIBUTE = "data-dsh-lumen-splash";
/** How long to wait for a painted frame before giving up on the clip, ms. */
const FIRST_FRAME_DEADLINE_MS = 8000;
/** Longest a clip may stand before it is taken down regardless, ms. */
const PLAY_DEADLINE_MS = 120000;
/**
 * How long the dismissing gesture stays owned by the splash, ms.
 *
 * A skip and a click on the panel underneath are the same physical motion when
 * the panel happens to be the page: the layer is removed inside the click that
 * skipped it, so anything the same finger does next lands on an interface it
 * has not seen yet. This is the window in which that second event is refused.
 */
const CLICK_THROUGH_MS = 400;
/** Every event a completed or in-flight pointer gesture can produce, for the window above. */
const SWALLOWED_TYPES = ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click"];
/** `inset` is not understood by every engine this runs on; four sides always are. */
const FULL_BLEED = { position: "fixed", top: "0", left: "0", right: "0", bottom: "0" };
/**
 * The clip layer's stacking order.
 *
 * 2147483647 is the largest z-index CSS accepts, and that is the whole
 * argument, not a shrug: a value nothing else may exceed is the only value that
 * cannot be beaten. Floating overlays from other plugins in this app routinely
 * reach for very large numbers — the convention here is that whatever popup is
 * currently showing owns the top of the stack — so anything short of the
 * maximum would end up covered mid-splash, and only during the moments somebody
 * else happened to be showing something, which is the hardest kind of bug to
 * reproduce.
 *
 * The reversal matters just as much: this layer is *gone* by the time the
 * interface is usable, so it never permanently outranks anything.
 */
const LAYER_Z_INDEX = 2147483647;

/** Which kind a MIME type is, or null when it is not one we will send. */
function classify(type) {
	const value = typeof type === "string" ? type.toLowerCase() : "";
	return ACCEPTED_TYPES.has(value) ? ACCEPTED_TYPES.get(value) : null;
}

/** The MIME type a file should be sent as, or null when it is not accepted. */
function contentTypeOf(file) {
	if (file === null || file === undefined) return null;
	const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
	return ACCEPTED_TYPES.has(type) ? type : null;
}

/** Parse a JSON body, tolerating every way it can fail — including a missing body. */
async function readJson(response) {
	try {
		if (response === null || response === undefined || typeof response.json !== "function") return null;
		return await response.json();
	} catch {
		return null;
	}
}

/** The host's own error code out of a failed response, for the caller to translate. */
function reasonOf(payload, response, fallback) {
	if (payload !== null && payload.error !== undefined && typeof payload.error.code === "string") return payload.error.code;
	if (response !== null && response !== undefined && typeof response.status === "number") return `${fallback}-${response.status}`;
	return fallback;
}

/**
 * Create the splash's browser half.
 *
 * @param {object} deps
 * @param {Function} [deps.t] translator; unknown keys fall back to the key
 * @param {Function} [deps.fetchImpl] `null` means there is no host channel
 * @param {object} [deps.window]
 * @param {object} [deps.document]
 */
function createSplash(deps) {
	const options = deps || {};
	const t = typeof options.t === "function" ? options.t : (key) => key;
	const win = options.window || (typeof window !== "undefined" ? window : null);
	const doc = options.document || (typeof document !== "undefined" ? document : null);
	const fetchImpl = Object.prototype.hasOwnProperty.call(options, "fetchImpl")
		? typeof options.fetchImpl === "function"
			? options.fetchImpl
			: null
		: typeof fetch === "function"
			? fetch.bind(globalThis)
			: null;

	let disposed = false;
	let started = false;
	/** Coarse lifecycle, published for the diagnostics snapshot and for tests. */
	let phase = "idle";
	/** The live clip layer, when there is one. */
	let layer = null;
	/** Tear-down for the live clip, or null. Assigned by {@link playClip}. */
	let clipStop = null;
	/** The capture-phase listener that owns the dismissing gesture, or null. */
	let swallower = null;
	/** Deadline for {@link swallower}, ms timer id, or null. */
	let swallowTimer = null;
	/** Set once the interface has been revealed by this half. */
	let revealed = false;

	/**
	 * The guard, when this document was served with a cover.
	 *
	 * Read through `win` rather than `globalThis` so a test can supply a window;
	 * in a browser the two are the same object.
	 */
	function coverBridge() {
		try {
			if (win === null || win === undefined) return null;
			const bridge = win[COVER_BRIDGE];
			if (bridge === null || bridge === undefined || typeof bridge !== "object") return null;
			return typeof bridge.lift === "function" ? bridge : null;
		} catch {
			return null;
		}
	}

	/** Reveal the interface. Idempotent, and never throws. */
	function lift(bridge) {
		if (revealed) return;
		revealed = true;
		try {
			bridge.lift();
		} catch {
			// The guard is somebody else's code in the same document. If it has
			// gone wrong, the deadline inside it is still the way out — there is
			// nothing useful this side can do about it and nothing to report.
		}
	}

	/** Ask the host what the splash is. */
	async function probe() {
		if (fetchImpl === null) return null;
		try {
			const response = await fetchImpl(MEDIA_PATH, { method: "HEAD", credentials: "same-origin" });
			if (response === null || response === undefined || typeof response.status !== "number") return null;
			if (response.status === 404) return { configured: false, kind: null, bytes: 0, source: "off" };
			if (response.ok !== true) return null;
			const header = (name) => {
				try {
					if (response.headers !== null && response.headers !== undefined && typeof response.headers.get === "function") {
						return String(response.headers.get(name) || "");
					}
				} catch {}
				return "";
			};
			const type = header("content-type");
			const kind = type.split(";")[0].trim().toLowerCase().indexOf("video/") === 0 ? "video" : "image";
			// Which source is being served. A host that predates the built-in
			// clip sends no such header, and its only source was the user's own
			// upload — so a missing header is "custom", not "unknown".
			const source = header(SOURCE_HEADER) === "builtin" ? "builtin" : "custom";
			return { configured: true, kind, bytes: Number(header("content-length")) || 0, source };
		} catch {
			return null;
		}
	}

	/**
	 * Send one file to the host, which stores it and points the splash at it.
	 *
	 * The file's own bytes are the request body. There is no base64, no
	 * `FileReader` and no size check here: the host owns the ceiling, and a
	 * second opinion about it on this side could only disagree with the one that
	 * decides.
	 */
	async function upload(file) {
		if (fetchImpl === null) return { ok: false, reason: "no-host" };
		const type = contentTypeOf(file);
		if (type === null) return { ok: false, reason: "unsupported-type" };
		try {
			const response = await fetchImpl(UPLOAD_PATH, {
				method: "POST",
				headers: { "content-type": type },
				credentials: "same-origin",
				body: file
			});
			const payload = await readJson(response);
			if (response !== null && response.ok === true && payload !== null && payload.ok === true && payload.value !== undefined) {
				return {
					ok: true,
					media: payload.value.media,
					kind: payload.value.kind,
					bytes: Number(payload.value.bytes) || 0
				};
			}
			return { ok: false, reason: reasonOf(payload, response, "upload") };
		} catch {
			return { ok: false, reason: "network" };
		}
	}

	/** Forget the splash and let the host remove its bytes. */
	async function clear() {
		if (fetchImpl === null) return { ok: false, reason: "no-host" };
		try {
			const response = await fetchImpl(CLEAR_PATH, { method: "POST", credentials: "same-origin" });
			const payload = await readJson(response);
			if (response !== null && response.ok === true && payload !== null && payload.ok === true && payload.value !== undefined) {
				return { ok: true, cleared: payload.value.cleared === true };
			}
			return { ok: false, reason: reasonOf(payload, response, "clear") };
		} catch {
			return { ok: false, reason: "network" };
		}
	}

	/**
	 * Point the splash back at the clip this package ships with.
	 *
	 * This is the cheap way out of a custom splash, and the panel has to say what
	 * it costs: the host drops the preference *and* the file, because nothing
	 * references those bytes afterwards and leaving them behind would grow
	 * `lumen-media` with a clip that can never be served again. Switching back to
	 * the user's own clip means choosing it again — which is why the message this
	 * produces differs depending on whether there was anything to lose.
	 */
	async function useBuiltin() {
		if (fetchImpl === null) return { ok: false, reason: "no-host" };
		try {
			const response = await fetchImpl(BUILTIN_PATH, { method: "POST", credentials: "same-origin" });
			const payload = await readJson(response);
			if (response !== null && response.ok === true && payload !== null && payload.ok === true) return { ok: true };
			return { ok: false, reason: reasonOf(payload, response, "builtin") };
		} catch {
			return { ok: false, reason: "network" };
		}
	}

	/**
	 * Stop owning the dismissing gesture.
	 *
	 * Called at the first completed click, at the deadline, and on teardown — the
	 * last of which matters most: a capture listener left on `document` after this
	 * module is gone would outlive the thing it was protecting, and would silently
	 * eat the interface's first click.
	 */
	function endSwallow() {
		if (swallower === null) return;
		const handler = swallower;
		swallower = null;
		for (const type of SWALLOWED_TYPES) {
			try {
				doc.removeEventListener(type, handler, true);
			} catch {}
		}
		try {
			if (swallowTimer !== null) win.clearTimeout(swallowTimer);
		} catch {}
		swallowTimer = null;
	}

	/**
	 * Take ownership of the gesture that dismissed the splash.
	 *
	 * WHY THIS EXISTS AT ALL
	 *
	 * Skipping is a click anywhere on the layer, and the settings panel is
	 * routinely the page underneath it. Removing the layer inside that click does
	 * not re-dispatch it — but it does move the ground under the *same* gesture: a
	 * press that started on the layer can be released on the panel that has just
	 * appeared, and the browser reports the click against whatever those two
	 * points have in common. A second, impatient click does the same thing more
	 * directly, and 关闭开屏 can sit exactly where the skip hint was.
	 *
	 * That is not hypothetical. It is the observed way the built-in splash got
	 * switched off for somebody who had done nothing but try to skip it: the clip
	 * got shorter, the confirmation click came after the layer was gone, and the
	 * control under the cursor was the one that disables the splash. The symptom —
	 * "it just does not appear any more" — is nearly impossible to diagnose from
	 * the outside, so the cause is removed rather than documented.
	 *
	 * Capture phase, because the panel's handlers are ordinary ones: an event
	 * stopped before it reaches its target never activates anything.
	 * `preventDefault` too, for the browser-level defaults a click still carries.
	 */
	function beginSwallow() {
		if (swallower !== null) return;
		const handler = (event) => {
			try {
				event.stopPropagation();
				event.preventDefault();
			} catch {}
			// A click is the end of one gesture. Anything after it is the user's
			// next intention and must reach the interface untouched.
			if (event !== null && event !== undefined && event.type === "click") endSwallow();
		};
		swallower = handler;
		for (const type of SWALLOWED_TYPES) {
			try {
				doc.addEventListener(type, handler, true);
			} catch {}
		}
		try {
			swallowTimer = win.setTimeout(endSwallow, CLICK_THROUGH_MS);
		} catch {}
	}

	/** Remove the clip layer and stop everything it installed. Idempotent. */
	function dismissClip() {
		if (clipStop !== null) {
			clipStop();
			clipStop = null;
		}
		// Teardown outranks the grace window: nobody is going to see the click this
		// was holding back, so holding it back would only lose the next real one.
		endSwallow();
		if (layer !== null) {
			try {
				if (layer.parentNode !== null && layer.parentNode !== undefined) layer.parentNode.removeChild(layer);
			} catch {}
			layer = null;
		}
	}

	/**
	 * Build the layer, play the clip, and wire every way it can end.
	 *
	 * The layer is what the user sees, so it is built first and completely: a
	 * half-built layer that then throws would leave an opaque black rectangle
	 * with nothing in it, which is worse than no splash at all.
	 */
	function playClip(bridge) {
		if (doc === null || doc.body === null || doc.body === undefined) {
			// Nothing to mount into. The guard's own deadline is the way out, and
			// there is nothing here worth logging about it.
			lift(bridge);
			return;
		}
		const element = doc.createElement("div");
		element.setAttribute(LAYER_ATTRIBUTE, "clip");
		element.setAttribute("role", "presentation");
		for (const [name, value] of Object.entries(FULL_BLEED)) element.style[name] = value;
		element.style.zIndex = String(LAYER_Z_INDEX);
		element.style.background = "#000000";
		element.style.display = "flex";
		element.style.alignItems = "center";
		element.style.justifyContent = "center";
		element.style.overflow = "hidden";

		const clip = doc.createElement("video");
		// Muted by necessity, not by preference: every engine refuses to autoplay
		// a clip with audio, and a splash that does not play is not a splash. The
		// attribute and the property are both set because the autoplay policy
		// honours whichever it reads first.
		clip.setAttribute("muted", "");
		clip.setAttribute("playsinline", "");
		clip.setAttribute("autoplay", "");
		clip.setAttribute("aria-hidden", "true");
		clip.muted = true;
		clip.playsInline = true;
		clip.autoplay = true;
		clip.style.width = "100%";
		clip.style.height = "100%";
		clip.style.objectFit = "cover";
		clip.src = MEDIA_PATH;

		const hint = doc.createElement("div");
		hint.textContent = t("splash.skip");
		hint.setAttribute("aria-hidden", "true");
		hint.style.position = "absolute";
		hint.style.right = "18px";
		hint.style.bottom = "16px";
		hint.style.color = "rgba(255,255,255,0.66)";
		hint.style.font = "12px/1.4 system-ui, sans-serif";
		hint.style.letterSpacing = "0.06em";
		hint.style.pointerEvents = "none";

		element.appendChild(clip);
		element.appendChild(hint);
		doc.body.appendChild(element);
		layer = element;

		let dismissed = false;
		let firstFrameTimer = null;
		let playTimer = null;
		/** Whether a finger or button went down on the layer and has not come back up. */
		let pointerHeld = false;

		const on = (target, type, handler) => {
			try {
				if (target !== null && target !== undefined && typeof target.addEventListener === "function") target.addEventListener(type, handler);
			} catch {}
		};
		const off = (target, type, handler) => {
			try {
				if (target !== null && target !== undefined && typeof target.removeEventListener === "function") target.removeEventListener(type, handler);
			} catch {}
		};
		const clearTimers = () => {
			try {
				if (firstFrameTimer !== null) win.clearTimeout(firstFrameTimer);
				if (playTimer !== null) win.clearTimeout(playTimer);
			} catch {}
			firstFrameTimer = null;
			playTimer = null;
		};

		/**
		 * The first-frame deadline only.
		 *
		 * Kept separate from {@link clearTimers} because the two deadlines mean
		 * different things and only one of them is answered by a started clip. A
		 * clip that plays its first frame has answered "will this ever start" and
		 * must not be given up on — but it has answered nothing about "will this
		 * ever finish", and a clip that stalls mid-play fires no event at all, so
		 * the lifetime budget is the only thing left standing between a stalled
		 * decoder and an interface nobody can reach.
		 */
		const clearFirstFrame = () => {
			try {
				if (firstFrameTimer !== null) win.clearTimeout(firstFrameTimer);
			} catch {}
			firstFrameTimer = null;
		};

		/** The clip is over, or never started, or was skipped. Take the layer down. */
		const dismiss = (fromGesture) => {
			if (dismissed) return;
			dismissed = true;
			clearTimers();
			off(clip, "playing", onPlaying);
			off(clip, "ended", dismiss);
			off(clip, "error", dismiss);
			off(element, "click", onSkip);
			off(element, "pointerdown", onPointerDown);
			off(doc, "pointerup", onPointerUp);
			off(doc, "keydown", onKeyDown);
			// Order matters: taking the layer down ends any swallow, so the gesture
			// this dismissal owns has to be claimed *after* the teardown, not before.
			const claimGesture = fromGesture === true || pointerHeld;
			pointerHeld = false;
			clipStop = null;
			dismissClip();
			// Either the user's own gesture dismissed this, or the clip ended while a
			// finger was still down on the layer. In both cases a release is still
			// coming, and it is no longer meant for whatever is underneath.
			if (claimGesture) beginSwallow();
			// Leaving the interface covered after the clip is gone is the one
			// unrecoverable outcome there is, so a dismissal always reveals too.
			lift(bridge);
		};

		/**
		 * Keyboard skip.
		 *
		 * Enter and Space are the two keys that activate whatever holds focus, and
		 * the shell's boot layer can hold it. Refusing their default is the keyboard
		 * counterpart of {@link beginSwallow}: the key that dismisses the splash
		 * must not also press a control the user has never seen.
		 */
		const onKeyDown = (event) => {
			try {
				const key = event === null || event === undefined ? undefined : event.key;
				if (key === "Enter" || key === " " || key === "Spacebar") event.preventDefault();
			} catch {}
			dismiss(true);
		};

		/**
		 * The first painted frame.
		 *
		 * This — and not the shell's boot handoff — is the moment the black can
		 * go: the layer is opaque and on top, so revealing earlier would only
		 * trade a black screen for a black screen one layer down.
		 */
		const onPlaying = () => {
			clearFirstFrame();
			lift(bridge);
		};

		const onPointerDown = () => {
			pointerHeld = true;
		};
		const onPointerUp = () => {
			pointerHeld = false;
		};

		/**
		 * The skip itself.
		 *
		 * Kept as its own function, rather than wiring `dismiss` straight to the
		 * event, because the gesture flag must be unambiguous: a listener receives
		 * an event where a plain call receives nothing, and "was this a gesture"
		 * may not depend on the shape of an argument.
		 */
		const onSkip = () => {
			dismiss(true);
		};

		on(clip, "playing", onPlaying);
		on(clip, "ended", dismiss);
		on(clip, "error", dismiss);
		// The whole viewport is the skip target. It is the only affordance that
		// needs no translation and cannot be missed by somebody who wants out.
		on(element, "click", onSkip);
		on(element, "pointerdown", onPointerDown);
		on(doc, "pointerup", onPointerUp);
		on(doc, "keydown", onKeyDown);

		clipStop = dismiss;
		try {
			firstFrameTimer = win.setTimeout(dismiss, FIRST_FRAME_DEADLINE_MS);
			playTimer = win.setTimeout(dismiss, PLAY_DEADLINE_MS);
		} catch {}
		try {
			const started_ = typeof clip.play === "function" ? clip.play() : null;
			// A rejected `play()` is not an error here: the element may already be
			// playing, and if it genuinely will not, the first-frame deadline is
			// the thing that ends this.
			if (started_ !== null && started_ !== undefined && typeof started_.catch === "function") started_.catch(() => {});
		} catch {
			// A synchronous throw from `play()` means the clip will never start;
			// do not wait eight seconds to find that out.
			dismiss();
		}
	}

	/**
	 * Begin the boot lifecycle.
	 *
	 * Called once, as early as the plugin's `apply` can manage, because the whole
	 * value of a clip splash is that it starts before the interface does.
	 */
	function startCover() {
		if (disposed || started) return;
		started = true;
		const bridge = coverBridge();
		if (bridge === null) {
			// No cover was injected, so this document was not served with a splash.
			// See the file header: playing one anyway is a different decision, made
			// without the black to arrive against.
			phase = "no-cover";
			return;
		}
		phase = "probing";
		probe().then((result) => {
			if (disposed || layer !== null) return;
			if (result === null || result.configured !== true || result.kind !== "video") {
				// A picture, or nothing at all. The guard already paints it and
				// already knows when the shell has taken over; this half must not
				// touch the release in either case.
				phase = "guard-only";
				return;
			}
			phase = "clip";
			// Suspend the guard before mounting, not after: the handoff can happen
			// between the two, and a cover that came down in that window would show
			// the interface for exactly as long as the clip took to attach.
			try {
				bridge.keep();
			} catch {}
			playClip(bridge);
		}).catch(() => {
			// `probe` is written not to reject; if it somehow does, the guard's own
			// deadline is still standing and will release the interface.
			phase = "degraded";
		});
	}

	return {
		startCover,
		probe,
		upload,
		clear,
		useBuiltin,
		/** Remove the clip layer early, if there is one. Used by teardown. */
		dismiss: dismissClip,
		/** Whether a region is a picture or a clip, for callers classifying a drop. */
		classify,
		dispose() {
			disposed = true;
			dismissClip();
		},
		/** Read-only view of what this half is doing, for diagnostics and tests. */
		inspect: () => ({ phase, layer: layer !== null, revealed, started }),
		/** Exposed so the panel can build a route without a second copy of it. */
		routes: { media: MEDIA_PATH, upload: UPLOAD_PATH, clear: CLEAR_PATH, builtin: BUILTIN_PATH }
	};
}

module.exports = { createSplash, ACCEPTED_TYPES, classify, LAYER_ATTRIBUTE, LAYER_Z_INDEX, MEDIA_PATH, UPLOAD_PATH, CLEAR_PATH, BUILTIN_PATH, COVER_BRIDGE };
