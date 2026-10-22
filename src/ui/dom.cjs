"use strict";
/**
 * A very small DOM builder.
 *
 * WHY NOT REACT. The plugin's settings UI has to be usable in two places: the
 * real DSH settings section (React 18, via the slots service) and the standalone
 * preview page (no framework at all). Writing the panel against the DOM gives
 * one implementation that both can host, one that can be driven and asserted on
 * without a renderer, and one that cannot break because a host upgraded React.
 *
 * The React side still exists — `react-bridge.cjs` wraps this panel in a
 * fifteen-line component that mounts it into a ref. What it must NOT do is
 * duplicate the panel.
 *
 * Deliberately minimal: create, set attributes, set text, listen. No virtual
 * DOM, no diffing, no lifecycle. The panel knows which parts are dynamic and
 * updates them itself, which is both faster and far easier to reason about than
 * a reconciliation pass through a hand-rolled renderer.
 */

/** Create an element. `props` accepts `class`, `text`, `html`, `style`, `on`, `data`, `attrs`. */
function h(tag, props, children) {
	const el = document.createElement(tag);
	const p = props || {};
	if (p.class) el.className = p.class;
	if (p.text !== undefined && p.text !== null) el.textContent = String(p.text);
	if (p.html !== undefined && p.html !== null) el.innerHTML = p.html;
	if (p.style && typeof p.style === "object") {
		for (const [key, value] of Object.entries(p.style)) {
			if (value === null || value === undefined) continue;
			// Custom properties must go through setProperty; assigning them to
			// `style[key]` silently does nothing.
			if (key.startsWith("--")) el.style.setProperty(key, String(value));
			else el.style[key] = typeof value === "number" ? `${value}px` : String(value);
		}
	}
	if (p.attrs && typeof p.attrs === "object") {
		for (const [key, value] of Object.entries(p.attrs)) {
			if (value === null || value === undefined || value === false) continue;
			if (value === true) el.setAttribute(key, "");
			else el.setAttribute(key, String(value));
		}
	}
	if (p.on && typeof p.on === "object") {
		for (const [event, handler] of Object.entries(p.on)) {
			if (typeof handler === "function") el.addEventListener(event, handler);
		}
	}
	append(el, children);
	return el;
}

/** Append a child that may be a node, a string, `null`, or an array of those. */
function append(parent, children) {
	if (children === null || children === undefined || children === false) return parent;
	if (Array.isArray(children)) {
		for (const child of children) append(parent, child);
		return parent;
	}
	if (typeof children === "string" || typeof children === "number") {
		parent.appendChild(document.createTextNode(String(children)));
		return parent;
	}
	parent.appendChild(children);
	return parent;
}

/** Remove every child. */
function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
	return el;
}

/** Replace every child with `children`. */
function replace(el, children) {
	clear(el);
	append(el, children);
	return el;
}

/** A settings row: label (+ optional hint) on the left, control on the right. */
function row(label, hint, control) {
	return h("div", { class: "lumen-row" }, [
		h("div", { class: "lumen-row-label" }, [
			h("span", { class: "lumen-row-title", text: label }),
			hint ? h("span", { class: "lumen-row-hint", text: hint }) : null
		]),
		h("div", { class: "lumen-row-control" }, control)
	]);
}

/** A group heading inside the panel. */
function group(title, hint) {
	return h("div", { class: "lumen-group" }, [
		h("span", { class: "lumen-group-title", text: title }),
		hint ? h("span", { class: "lumen-group-hint", text: hint }) : null
	]);
}

/**
 * A top-level section: one heading that owns everything below it.
 *
 * The panel is long enough that a flat run of group headings reads as one list
 * of unrelated settings — the three things this plugin actually changes (the
 * wallpaper, the splash, the composer) got lost in it. A section is that unit:
 * a heading, a one-line statement of what the section is for, then its groups.
 *
 * @param {string} title section heading
 * @param {string|null} hint one line under the heading, or null
 * @param {Array} children nodes to place under the head; nulls are dropped
 */
function section(title, hint, children, options) {
	const opt = options || {};
	const body = [];
	for (const child of children || []) {
		if (child !== null && child !== undefined) body.push(child);
	}
	// A node is accepted as the hint so a section can keep it live: the wallpaper
	// section says what is applied right now, which changes without rebuilding
	// the panel.
	const hintNode =
		hint && typeof hint === "object" ? hint : hint ? h("span", { class: "lumen-section-hint", text: hint }) : null;
	const head = h(opt.collapsible ? "summary" : "div", { class: "lumen-section-head" }, [
		h("h3", { class: "lumen-section-title", text: title }),
		hintNode,
		opt.collapsible ? h("span", { class: "lumen-section-caret", attrs: { "aria-hidden": "true" } }) : null
	]);
	const shell = h(opt.collapsible ? "details" : "section", { class: `lumen-section${opt.collapsible ? " is-collapsible" : ""}` }, [
		head,
		h("div", { class: "lumen-section-body" }, body)
	]);
	// `<details>` carries its own open state, and a collapsed panel is a saved
	// preference as much as a visual one — so it is set after construction, where
	// the attribute means the same thing to every engine.
	if (opt.collapsible && opt.open === true) shell.setAttribute("open", "");
	return shell;
}

/**
 * A fold inside a section, for the settings a person changes once.
 *
 * Same `<details>` mechanics as a collapsible section, deliberately a different
 * shape: no section-sized heading, one hairline above it, and a summary that
 * reads as "there is more under here" rather than "this is another category".
 *
 * @param {string} title summary label
 * @param {string|null} hint one line beside the label
 * @param {Array} children contents, revealed when opened
 */
function disclosure(title, hint, children) {
	const body = [];
	for (const child of children || []) {
		if (child !== null && child !== undefined) body.push(child);
	}
	return h("details", { class: "lumen-disclosure" }, [
		h("summary", { class: "lumen-disclosure-head" }, [
			h("span", { class: "lumen-disclosure-title", text: title }),
			hint ? h("span", { class: "lumen-disclosure-hint", text: hint }) : null,
			h("span", { class: "lumen-section-caret", attrs: { "aria-hidden": "true" } })
		]),
		h("div", { class: "lumen-disclosure-body" }, body)
	]);
}

/**
 * A range slider with a live value readout.
 * `onInput` fires on every pixel during a drag — the callers are all cheap
 * enough for that, and a slider that only reacts on release feels broken.
 */
function slider(options) {
	const o = options || {};
	const readout = h("span", { class: "lumen-slider-value" });
	const input = h("input", {
		class: "lumen-slider-input",
		attrs: {
			type: "range",
			min: o.min,
			max: o.max,
			step: o.step === undefined ? 1 : o.step,
			value: o.value,
			"aria-label": o.label || "value"
		}
	});
	const format = typeof o.format === "function" ? o.format : (v) => String(v);
	/**
	 * Paint the readout and the track's filled portion.
	 *
	 * The fill is a CSS custom property rather than a second element: the
	 * stylesheet draws the track as a two-stop gradient and this only moves the
	 * stop, so the "how much" is visible without the slider having to know
	 * anything about colour.
	 */
	const paint = (value) => {
		readout.textContent = format(value);
		const span = Number(o.max) - Number(o.min);
		const ratio = span > 0 ? (Number(value) - Number(o.min)) / span : 0;
		const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10;
		input.style.setProperty("--lumen-fill", `${percent}%`);
	};
	paint(o.value);
	input.addEventListener("input", () => {
		const value = Number(input.value);
		paint(value);
		if (typeof o.onInput === "function") o.onInput(value);
	});
	return {
		el: h("div", { class: "lumen-slider" }, [input, readout]),
		set: (value) => {
			input.value = String(value);
			paint(value);
		}
	};
}

/**
 * A segmented control (2-4 mutually exclusive options).
 * Chosen over a `<select>` because every one of these choices changes the page
 * behind the panel — the user needs to see the alternatives, not a dropdown.
 */
function segmented(options) {
	const o = options || {};
	const buttons = [];
	const el = h("div", { class: "lumen-segmented" });
	const paint = (value) => {
		for (const button of buttons) {
			const on = button.dataset.value === String(value);
			button.classList.toggle("is-on", on);
			button.setAttribute("aria-pressed", on ? "true" : "false");
		}
	};
	for (const option of o.options || []) {
		const button = h("button", {
			class: "lumen-seg",
			text: option.label,
			attrs: { type: "button", title: option.hint || "", "data-value": option.value },
			on: {
				click: () => {
					paint(option.value);
					if (typeof o.onChange === "function") o.onChange(option.value);
				}
			}
		});
		buttons.push(button);
		el.appendChild(button);
	}
	paint(o.value);
	return { el, set: paint };
}

/** A horizontal group of free-form chips (the recipe picker). */
function chipStrip() {
	const el = h("div", { class: "lumen-chips" });
	return { el, add: (chip) => el.appendChild(chip) };
}

/** A toggle switch. */
function toggle(options) {
	const o = options || {};
	const input = h("input", { class: "lumen-toggle-input", attrs: { type: "checkbox" } });
	input.checked = o.value === true;
	input.addEventListener("change", () => {
		if (typeof o.onChange === "function") o.onChange(input.checked);
	});
	const el = h("label", { class: "lumen-toggle" }, [input, h("span", { class: "lumen-toggle-track" }, h("span", { class: "lumen-toggle-knob" }))]);
	return {
		el,
		set: (value) => {
			input.checked = value === true;
		}
	};
}

/** A plain button. */
function button(label, onClick, options) {
	const o = options || {};
	return h("button", {
		class: `lumen-btn${o.variant ? ` lumen-btn-${o.variant}` : ""}${o.small ? " is-small" : ""}`,
		text: label,
		attrs: { type: "button", title: o.hint || "" },
		on: { click: onClick }
	});
}

/** A miniature wallpaper preview (used by the recipe chips and playlist). */
function swatch(backgroundImage, backgroundColor, options) {
	const o = options || {};
	return h("span", {
		class: `lumen-swatch${o.large ? " is-large" : ""}`,
		style: { backgroundImage, backgroundColor, backgroundSize: "cover", backgroundPosition: "center" },
		attrs: { "aria-hidden": "true" }
	});
}

/**
 * A file picker that reports every chosen file once, then clears itself.
 *
 * `multiple` because importing a wallpaper is rarely a one-picture job: a user
 * with a folder of candidates should be able to hand the whole set over in one
 * gesture and let the playlist hold them. The handler always receives an ARRAY,
 * even when the input is not `multiple`, so the caller has one shape to write
 * against rather than two.
 *
 * `options.multiple: false` exists for the one caller that wants a single file —
 * a splash is one file by definition, and an input that invites a batch into it
 * would be offering a choice the route behind it cannot honour.
 */
function filePicker(accept, onFiles, options) {
	const o = options || {};
	const input = h("input", {
		class: "lumen-file-input",
		attrs: { type: "file", accept, multiple: o.multiple === false ? null : true }
	});
	input.addEventListener("change", () => {
		const chosen = input.files ? Array.prototype.slice.call(input.files) : [];
		// Clear immediately: re-picking the same file must fire `change` again,
		// which it will not while the input still holds it.
		input.value = "";
		if (chosen.length > 0 && typeof onFiles === "function") onFiles(chosen);
	});
	return input;
}

/**
 * Accept files dropped anywhere inside `el`.
 *
 * Returns a teardown, so a caller that rebuilds its subtree does not leave
 * handlers behind pointing at detached nodes.
 *
 * The enter/leave pair is counted rather than toggled, because `dragleave`
 * fires every time the pointer crosses into a child element. A naive
 * add-on-enter/remove-on-leave flickers the highlight off and on while the
 * pointer is still inside the target — the counting makes the highlight mean
 * "the pointer is somewhere in here", which is what it looks like it means.
 */
function acceptDrops(el, onFiles, options) {
	const o = options || {};
	const activeClass = o.activeClass || "is-drop";
	let depth = 0;
	const stop = (event) => {
		if (event && typeof event.preventDefault === "function") event.preventDefault();
	};
	const onDragOver = (event) => {
		stop(event);
		// Without this the browser reports "no drop allowed" and the drop never fires.
		if (event && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	};
	const onDragEnter = (event) => {
		stop(event);
		depth += 1;
		if (el.classList) el.classList.add(activeClass);
	};
	const onDragLeave = () => {
		depth = Math.max(0, depth - 1);
		if (depth === 0 && el.classList) el.classList.remove(activeClass);
	};
	const onDrop = (event) => {
		stop(event);
		depth = 0;
		if (el.classList) el.classList.remove(activeClass);
		const transfer = event ? event.dataTransfer : null;
		const list = transfer ? transfer.files : null;
		const files = list ? Array.prototype.slice.call(list) : [];
		if (files.length > 0 && typeof onFiles === "function") onFiles(files);
	};
	el.addEventListener("dragover", onDragOver);
	el.addEventListener("dragenter", onDragEnter);
	el.addEventListener("dragleave", onDragLeave);
	el.addEventListener("drop", onDrop);
	return () => {
		el.removeEventListener("dragover", onDragOver);
		el.removeEventListener("dragenter", onDragEnter);
		el.removeEventListener("dragleave", onDragLeave);
		el.removeEventListener("drop", onDrop);
	};
}

/**
 * A 3x3 grid of buttons, one per `background-position`.
 *
 * A grid rather than two sliders because the choices are not continuous: the
 * user is answering "which corner should the subject move towards", and nine
 * cells say that in one glance. It also needs no labels, which keeps it out of
 * the dictionary — the accessible name is the position itself.
 */
function grid9(options) {
	const o = options || {};
	const cells = [];
	const el = h("div", { class: "lumen-grid9", attrs: { role: "group", "aria-label": o.label || "position" } });
	const paint = (value) => {
		for (const cell of cells) {
			const on = cell.dataset.value === String(value);
			cell.classList.toggle("is-on", on);
			cell.setAttribute("aria-pressed", on ? "true" : "false");
		}
	};
	for (const entry of o.cells || []) {
		const cell = h("button", {
			class: "lumen-grid9-cell",
			attrs: { type: "button", "data-value": entry.value, title: entry.hint || "", "aria-label": entry.hint || entry.value },
			on: {
				click: () => {
					paint(entry.value);
					if (typeof o.onChange === "function") o.onChange(entry.value);
				}
			}
		});
		cells.push(cell);
		el.appendChild(cell);
	}
	paint(o.value);
	return { el, set: paint };
}

module.exports = {
	h,
	append,
	clear,
	replace,
	row,
	group,
	section,
	disclosure,
	slider,
	segmented,
	chipStrip,
	toggle,
	button,
	swatch,
	filePicker,
	acceptDrops,
	grid9
};
