"use strict";
/**
 * A minimal DOM, for tests only.
 *
 * WHY A HAND-WRITTEN DOUBLE RATHER THAN jsdom. Two reasons, and the second one
 * is the real one:
 *
 *   1. The package then has no test-time dependency to install. `node --test`
 *      works on a bare checkout, which is what makes the suite something a
 *      contributor actually runs.
 *   2. **It is an executable contract.** This file lists, exactly, every piece
 *      of the DOM the plugin touches — and nothing more. If a future change
 *      starts calling `matches`, or a `querySelector` with a selector this file
 *      does not understand, the tests fail here instead of failing on a user's
 *      machine, and the diff shows precisely how much new surface was taken on.
 *      A full DOM library would hide that change completely. (Two selectors have
 *      since been taken on, both narrowed to the shapes actually used: a bare
 *      `[attribute]` for `querySelector`, and tag names for
 *      `getElementsByTagName`.)
 *
 * `MutationObserver` is deliberately NOT here. The one caller is the injected
 * guard script, and the test for it supplies its own observer double so the
 * test can decide when a mutation "happens" — which is the whole point of
 * testing that script, and would be impossible with an observer this file
 * owned.
 *
 * It is NOT a browser: no layout, no cascade, no events beyond the ones
 * dispatched explicitly. Anything dependent on those belongs in the standalone
 * preview, which runs the real bundle against a real engine.
 */

/** Text node. */
class MiniText {
	constructor(data) {
		this.nodeType = 3;
		this.data = String(data);
		this.parentNode = null;
		this.childNodes = [];
	}
	get textContent() {
		return this.data;
	}
	set textContent(value) {
		this.data = String(value);
	}
}

/** Element. */
class MiniElement {
	constructor(tagName) {
		this.nodeType = 1;
		this.tagName = String(tagName).toUpperCase();
		this.childNodes = [];
		this.parentNode = null;
		this.attributes = Object.create(null);
		this.style = createStyle();
		this.listeners = Object.create(null);
		this._class = "";
		this._text = null;
		this.checked = false;
		this.disabled = false;
		this.value = "";
		this.files = null;
		this.id = "";
	}

	get className() {
		return this._class;
	}

	set className(value) {
		this._class = String(value);
	}

	get classList() {
		const read = () => (this._class.length === 0 ? [] : this._class.split(/\s+/).filter(Boolean));
		const write = (list) => {
			this._class = Array.from(new Set(list)).join(" ");
		};
		return {
			add: (...names) => write([...read(), ...names]),
			remove: (...names) => write(read().filter((n) => !names.includes(n))),
			contains: (name) => read().includes(name),
			toggle: (name, force) => {
				const has = read().includes(name);
				const on = force === undefined ? !has : force === true;
				write(on ? [...read(), name] : read().filter((n) => n !== name));
				return on;
			}
		};
	}

	get dataset() {
		const self = this;
		return new Proxy({}, {
			get(_, key) {
				return self.attributes[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`];
			}
		});
	}

	get firstChild() {
		return this.childNodes[0] || null;
	}

	get lastChild() {
		return this.childNodes[this.childNodes.length - 1] || null;
	}

	get textContent() {
		if (this._text !== null) return this._text;
		return this.childNodes.map((child) => child.textContent).join("");
	}

	set textContent(value) {
		this.childNodes = [];
		this._text = String(value);
	}

	set innerHTML(value) {
		this.childNodes = [];
		this._text = String(value);
	}

	get innerHTML() {
		return this._text === null ? "" : this._text;
	}

	appendChild(child) {
		if (child.parentNode !== null) child.parentNode.removeChild(child);
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}

	insertBefore(child, reference) {
		if (reference === null || reference === undefined) return this.appendChild(child);
		const index = this.childNodes.indexOf(reference);
		if (index < 0) return this.appendChild(child);
		if (child.parentNode !== null) child.parentNode.removeChild(child);
		child.parentNode = this;
		this.childNodes.splice(index, 0, child);
		return child;
	}

	prepend(child) {
		if (child.parentNode !== null) child.parentNode.removeChild(child);
		child.parentNode = this;
		this.childNodes.unshift(child);
		return child;
	}

	removeChild(child) {
		const index = this.childNodes.indexOf(child);
		if (index >= 0) this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}

	remove() {
		if (this.parentNode !== null) this.parentNode.removeChild(this);
	}

	contains(node) {
		if (node === this) return true;
		return this.childNodes.some((child) => child.contains && child.contains(node));
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
	}

	removeAttribute(name) {
		delete this.attributes[name];
	}

	/**
	 * Descendant elements with a given tag name.
	 *
	 * Case-insensitive, because the real one is. Returns an Array rather than an
	 * `HTMLCollection`: nothing in the plugin indexes it after construction, and
	 * an array can be asserted on directly.
	 */
	getElementsByTagName(tagName) {
		const wanted = String(tagName).toUpperCase();
		return this.queryAll((el) => el.tagName === wanted);
	}

	/**
	 * A deliberately narrow `querySelector`.
	 *
	 * Only the one selector shape the plugin actually uses is understood — a bare
	 * attribute selector — and anything else THROWS rather than returning null.
	 * That is the point of this double, stated at the top of the file: it is a
	 * list of the DOM surface the plugin has taken on. A selector it has not
	 * taken on should stop a test, not quietly match nothing and let some later
	 * assertion pass for a reason nobody chose.
	 */
	querySelector(selector) {
		const match = /^\[([a-zA-Z0-9-]+)\]$/.exec(String(selector));
		if (match === null) {
			throw new Error(`mini DOM: querySelector understands a bare [attribute] selector and nothing else, got ${JSON.stringify(selector)}`);
		}
		const attribute = match[1];
		const found = this.queryAll((el) => el.getAttribute(attribute) !== null);
		return found.length > 0 ? found[0] : null;
	}

	addEventListener(type, handler) {
		if (this.listeners[type] === undefined) this.listeners[type] = [];
		this.listeners[type].push(handler);
	}

	removeEventListener(type, handler) {
		const list = this.listeners[type];
		if (list === undefined) return;
		this.listeners[type] = list.filter((h) => h !== handler);
	}

	/** Dispatch an event object to registered listeners. */
	dispatch(type, event) {
		const payload = event || {};
		payload.type = type;
		payload.target = this;
		for (const handler of this.listeners[type] || []) handler(payload);
	}

	/** A `click()` that actually notifies listeners, unlike the real one's shorthand. */
	click() {
		this.dispatch("click", {});
	}

	getBoundingClientRect() {
		return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
	}

	/** Every descendant element, for assertions. */
	queryAll(predicate, out) {
		const found = out || [];
		for (const child of this.childNodes) {
			if (child.nodeType !== 1) continue;
			if (predicate(child)) found.push(child);
			child.queryAll(predicate, found);
		}
		return found;
	}
}

/**
 * A `style` object that behaves like `CSSStyleDeclaration` for the two access
 * patterns the plugin uses: dotted properties and `setProperty` for custom
 * properties (which must survive a round trip to be assertable).
 */
function createStyle() {
	const store = Object.create(null);
	const target = {
		setProperty(name, value) {
			store[name] = String(value);
		},
		removeProperty(name) {
			const previous = store[name] === undefined ? "" : store[name];
			delete store[name];
			return previous;
		},
		getPropertyValue(name) {
			return store[name] === undefined ? "" : store[name];
		},
		/** Read back any property, dotted or custom. */
		_read(name) {
			return store[name] === undefined ? "" : store[name];
		}
	};
	return new Proxy(target, {
		get(obj, key) {
			if (typeof key === "symbol") return obj[key];
			if (key in obj) return obj[key];
			return store[key] === undefined ? "" : store[key];
		},
		set(obj, key, value) {
			if (typeof key === "symbol") {
				obj[key] = value;
				return true;
			}
			store[key] = String(value);
			return true;
		}
	});
}

/** Create a document with `html > head, body`. */
function createDocument() {
	const document = {
		nodeType: 9,
		documentElement: new MiniElement("html"),
		head: new MiniElement("head"),
		body: new MiniElement("body"),
		visibilityState: "visible",
		listeners: Object.create(null),
		createElement: (tag) => new MiniElement(tag),
		createTextNode: (data) => new MiniText(data),
		getElementById: (id) => {
			const found = document.documentElement.queryAll((el) => el.id === id);
			return found.length > 0 ? found[0] : null;
		},
		addEventListener(type, handler) {
			if (document.listeners[type] === undefined) document.listeners[type] = [];
			document.listeners[type].push(handler);
		},
		removeEventListener(type, handler) {
			const list = document.listeners[type];
			if (list === undefined) return;
			document.listeners[type] = list.filter((h) => h !== handler);
		},
		dispatch(type, event) {
			const payload = event || {};
			payload.type = type;
			for (const handler of document.listeners[type] || []) handler(payload);
		},
		contains(node) {
			return document.documentElement.contains(node);
		}
	};
	document.documentElement.appendChild(document.head);
	document.documentElement.appendChild(document.body);
	return document;
}

/**
 * A window whose `requestAnimationFrame` is synchronous.
 *
 * Synchronous on purpose: a real rAF makes every panel assertion a race, and
 * the thing under test (that a drag repaints once per frame, not once per
 * pixel) is about *coalescing*, not about timing.
 *
 * Timers are `unref`'d where the runtime allows it. A double must not be able to
 * hang the test runner: the panel starts a one-second countdown ticker, and if
 * an assertion fails before `destroy()` runs, a live interval would keep the
 * process open forever with no failing test to show for it. Whether the interval
 * fires is not what any test asserts.
 */
function createWindow(document) {
	const unref = (id) => {
		if (id !== null && typeof id === "object" && typeof id.unref === "function") id.unref();
		return id;
	};
	const win = {
		document,
		navigator: { language: "zh-CN", clipboard: null },
		location: { href: "http://127.0.0.1:0/" },
		listeners: Object.create(null),
		requestAnimationFrame: (fn) => {
			fn();
			return 1;
		},
		cancelAnimationFrame: () => {},
		setInterval: (fn, ms) => unref(setInterval(fn, ms)),
		clearInterval: (id) => clearInterval(id),
		setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
		clearTimeout: (id) => clearTimeout(id),
		addEventListener(type, handler) {
			if (win.listeners[type] === undefined) win.listeners[type] = [];
			win.listeners[type].push(handler);
		},
		removeEventListener(type, handler) {
			const list = win.listeners[type];
			if (list === undefined) return;
			win.listeners[type] = list.filter((h) => h !== handler);
		}
	};
	return win;
}

/** A localStorage double with a working `length`/`key` pair. */
function createStorage() {
	const map = new Map();
	return {
		get length() {
			return map.size;
		},
		key: (index) => Array.from(map.keys())[index] ?? null,
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			map.set(String(key), String(value));
		},
		removeItem: (key) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		_raw: map
	};
}

module.exports = { MiniElement, MiniText, createDocument, createWindow, createStorage, createStyle };
