/**
 * The preview's control and inspection layer.
 *
 * This file boots the shipped bundle against the harness's fake platform, wires
 * the preview chrome, and then reads the plugin's own public surfaces once every
 * few hundred milliseconds:
 *
 *   window.__DSH_LUMEN__          the diagnostics snapshot the plugin publishes
 *   api.store.getState()/getHealth()
 *   api.engine.inspect()
 *   ctx.theme.rawTokens() vs ctx.theme.visibleTokens()
 *
 * Nothing here reaches inside the plugin. Everything on the right-hand side of
 * the page is either that snapshot or a *difference* between two public values,
 * which is the only kind of preview that cannot flatter the code it is showing:
 * the "exactly 2 tokens were overridden" line is computed by diffing what the
 * host published against what the plugin asked it to publish.
 *
 * The preview chrome is written in Chinese only, on purpose: it is a developer
 * tool, not part of the plugin. The plugin itself ships both dictionaries, and
 * the language toggle at the top is how you check that — switching it re-boots
 * the plugin through the same path a page reload takes.
 */

(function () {
	"use strict";

	const P = window.__DSH_LUMEN_PREVIEW__;
	const PLUGIN_ID = "dsh-lumen";
	const API_PATH = "/lumen/api";
	const REFRESH_MS = 300;
	const HOST_POLL_MS = 1500;
	const MAX_WARNINGS = 40;
	const TIMELINE_COUNT = 5;

	const $ = (id) => document.getElementById(id);
	const pad2 = (value) => String(value).padStart(2, "0");

	/**
	 * Every element id this file reads or writes.
	 *
	 * Listed once, on purpose. A readout that silently stops updating because a
	 * heading was renamed in `index.html` is the classic way a preview rots, and
	 * nothing else in the toolchain would notice: the JS still parses, the page
	 * still loads, and one number just freezes. So the list is checked against
	 * the document at startup and reported in the warning panel, and the test
	 * suite checks it against the HTML statically.
	 */
	const REQUIRED_IDS = [
		"pg-theme", "pg-lang", "pg-tabs",
		"pg-tab-panel", "pg-tab-sched", "pg-tab-diag",
		"pg-settings-mount", "pg-mount-note",
		"pg-demo", "pg-clock", "pg-clock-input", "pg-clock-apply", "pg-clock-reset",
		"pg-timeline", "pg-sched-source", "pg-status-badge",
		"pg-reboot", "pg-dispose", "pg-log", "pg-warn-count",
		"k-clock-real", "k-clock-plugin", "k-clock-offset",
		"k-sched-mode", "k-sched-kind", "k-sched-order", "k-sched-next", "k-sched-in",
		"k-sched-plan", "k-sched-playlist",
		"k-status", "k-build", "k-schema", "k-panel", "k-dom", "k-motion",
		"k-item", "k-item-kind",
		"k-wash-chosen", "k-wash-required", "k-wash-effective", "k-wash-autodim", "k-wash-readability",
		"k-host", "k-host-keys", "k-seed", "k-state-file", "k-last-error",
		"k-theme", "k-token-raw", "k-token-washed", "k-override-sources", "k-override-tokens",
		"k-slots", "k-locales"
	];

	const KIND_LABEL = {
		recipe: "内置配方 · 程序化生成",
		gradient: "自定义渐变",
		image: "本地图片 · data URL",
		url: "远程图片 · URL"
	};
	const ORDER_LABEL = { sequential: "顺序", shuffle: "洗牌（不重复抽完一轮）", random: "随机" };
	const MODE_LABEL = { interval: "按间隔", hourly: "整点", daily: "每日", session: "每次会话" };

	/** Offsets the demo offers. A week matters: it is the sleep-through case. */
	const CLOCK_STEPS = [
		{ label: "+15 分", ms: 15 * 60 * 1000 },
		{ label: "+1 小时", ms: 60 * 60 * 1000 },
		{ label: "+1 天", ms: 24 * 60 * 60 * 1000 },
		{ label: "+7 天", ms: 7 * 24 * 60 * 60 * 1000 }
	];

	// ── the plugin, loaded by the harness a moment ago ────────────────────────
	const plugin = P.module(PLUGIN_ID);
	const scheduler = plugin.__modules.scheduler;
	const wallpapers = plugin.__modules.wallpapers;
	const stateModule = plugin.__modules.state;
	const recipeById = new Map(wallpapers.RECIPES.map((recipe) => [recipe.id, recipe]));

	const preview = { boot: null, theme: "abyss", lang: "zh", hostInfo: null };
	const warnings = [];
	const cells = new Map();
	let timelineSignature = "";

	// ── console capture ───────────────────────────────────────────────────────
	// The plugin's failure mode is "one warning and a missing feature", so those
	// warnings are the only place a problem surfaces. Showing them is the point.
		const realWarn = console.warn.bind(console);
	console.warn = function captureWarn(...args) {
		const text = args.map((value) => (value && value.message) ? value.message : String(value)).join(" ");
		if (text.indexOf("[dsh-lumen]") === 0 || text.indexOf("[preview]") === 0) {
			warnings.push(text);
			if (warnings.length > MAX_WARNINGS) warnings.shift();
			renderWarnings();
		}
		realWarn(...args);
	};

	// ── tiny DOM helpers ─────────────────────────────────────────────────────
	function cell(id) {
		if (!cells.has(id)) cells.set(id, $(id));
		return cells.get(id);
	}

	function setText(id, value) {
		const node = cell(id);
		if (node === null || node === undefined) return;
		const text = value === null || value === undefined || value === "" ? "—" : String(value);
		if (node.textContent !== text) node.textContent = text;
	}

	function setTone(id, tone) {
		const node = cell(id);
		if (node === null || node === undefined) return;
		const next = tone ? `is-${tone}` : "";
		if (node.className !== next) node.className = next;
	}

	function setValue(id, value, tone) {
		setText(id, value);
		setTone(id, tone || null);
	}

	function button(label, onClick, extraClass) {
		const node = document.createElement("button");
		node.type = "button";
		node.className = `pg-btn${extraClass ? ` ${extraClass}` : ""}`;
		node.textContent = label;
		node.addEventListener("click", onClick);
		return node;
	}

	function stamp(ts, withDate) {
		const d = new Date(ts);
		const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
		if (withDate !== true) return clock;
		return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${clock}`;
	}

	function humanDuration(ms) {
		const total = Math.max(0, Math.round(ms / 1000));
		if (total < 60) return `${total} 秒`;
		const minutes = Math.floor(total / 60);
		if (minutes < 60) return `${minutes} 分 ${pad2(total % 60)} 秒`;
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return `${hours} 小时 ${pad2(minutes % 60)} 分`;
		return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
	}

	function truncate(text, limit) {
		const value = String(text);
		return value.length > limit ? `${value.slice(0, limit)}…` : value;
	}

	function itemName(item) {
		if (item === null || item === undefined) return "（无）";
		if (item.kind === "recipe") {
			const recipe = recipeById.get(item.ref);
			const label = recipe !== undefined ? `${recipe.name.zh} / ${recipe.name.en}` : item.ref;
			return `${label}${item.seed && item.seed !== "default" ? ` · seed ${item.seed}` : ""}`;
		}
		if (item.kind === "gradient") return truncate(item.ref, 72);
		if (item.kind === "image") return `(data URL · ${item.ref.length} 字符)`;
		return truncate(item.ref, 72);
	}

	// ── boot / dispose ───────────────────────────────────────────────────────
	function showMountNote(text) {
		const node = $("pg-mount-note");
		if (node !== null) node.textContent = text;
	}

	function disposeBoot() {
		if (preview.boot === null) return;
		const { unmountSettings, ctx } = preview.boot;
		// Unmount the React tree first so the panel's own `destroy` runs while the
		// store it subscribes to still exists; then dispose the context, which is
		// what fires the plugin's teardown effect.
		preview.boot = null;
		try {
			unmountSettings();
		} catch (error) {
			console.error("[preview] settings unmount threw:", error);
		}
		try {
			ctx.dispose();
		} catch (error) {
			console.error("[preview] ctx.dispose threw:", error);
		}
	}

	function boot(lang) {
		disposeBoot();
		preview.lang = lang === "en" ? "en" : "zh";

		const ctx = P.createContext();
		ctx.locale.setLanguage(preview.lang);
		ctx.theme.setPreference(preview.theme);
		// Publish the composed tokens before the plugin runs, so the mock shell is
		// already painted in the right palette when the first wallpaper lands.
		ctx.theme.mount(document.documentElement);

		let api = null;
		try {
			api = plugin.apply(ctx);
		} catch (error) {
			console.error("[preview] apply() threw:", error);
			showMountNote(`apply() 抛出了异常：${error && error.message} —— 插件的契约是永不抛错，这条若出现就是缺陷。`);
			preview.boot = { ctx, api: null, unmountSettings: () => {} };
			return;
		}

		const mount = $("pg-settings-mount");
		while (mount.firstChild) mount.removeChild(mount.firstChild);

		let unmountSettings = () => {};
		const section = ctx.slots.renderSlot("settings.section", {});
		if (section === null) {
			showMountNote("renderSlot(\"settings.section\") 返回 null：槽位没有注册成功（React 或 slots 服务缺失）。");
		} else {
			unmountSettings = P.renderer.mount(section.type, section.props, mount);
			showMountNote(`已通过 slots / React 桥接挂载，语言 ${preview.lang}。面板与左侧画布共用同一个 store——在面板里改任何一项，左边立刻跟着变。`);
		}

		preview.boot = { ctx, api, unmountSettings };
		refresh();
	}

	// ── controls ─────────────────────────────────────────────────────────────
	function renderThemeButtons() {
		const host = $("pg-theme");
		host.textContent = "";
		const options = P.themes.concat([{ id: "system", label: "跟随系统" }]);
		for (const option of options) {
			const node = button(option.label, () => {
				preview.theme = option.id;
				if (preview.boot !== null) preview.boot.ctx.theme.setPreference(option.id);
				renderThemeButtons();
				refresh();
			}, option.id === preview.theme ? "is-on" : "");
			host.appendChild(node);
		}
	}

	function renderLangButtons() {
		const host = $("pg-lang");
		host.textContent = "";
		for (const option of [{ id: "zh", label: "中文" }, { id: "en", label: "English" }]) {
			host.appendChild(button(option.label, () => {
				if (option.id === preview.lang) return;
				boot(option.id);
				renderLangButtons();
			}, option.id === preview.lang ? "is-on" : ""));
		}
	}

	/**
	 * Make the plugin re-evaluate the clock.
	 *
	 * Shifting the clock does not move any `setTimeout` that is already armed —
	 * a timer's delay is a duration, and a constant offset cannot change one. A
	 * real clock jump *would* fire the armed timer, and `engine.tick()` is
	 * exactly the code that runs when it does, so calling it is the honest
	 * simulation of the thing rather than a shortcut around it.
	 */
	function catchUp() {
		if (preview.boot === null || preview.boot.api === null) return;
		const { store, engine } = preview.boot.api;
		try {
			if (store.getState().mode === "rotation") engine.tick();
		} catch (error) {
			console.error("[preview] tick threw:", error);
		}
		// A no-op write that still notifies: no field differs, so no patch is
		// built and nothing reaches disk, but the panel's clock-derived readouts
		// (the "接下来" pills and the countdown) recompute.
		store.setState(store.getState());
	}

	function renderClockButtons() {
		const host = $("pg-clock");
		host.textContent = "";
		for (const step of CLOCK_STEPS) {
			host.appendChild(button(step.label, () => {
				P.advanceClock(step.ms);
				catchUp();
				refresh();
			}));
		}
		host.appendChild(button("归零", () => {
			P.shiftClock(0);
			catchUp();
			refresh();
		}));
	}

	/** One click to a rotation that is actually worth watching. */
	function seedRotationDemo() {
		if (preview.boot === null || preview.boot.api === null) return;
		const { store, engine } = preview.boot.api;
		const picks = wallpapers.RECIPE_IDS.slice(0, 4);
		const playlist = picks
			.map((id) => stateModule.createItem("recipe", id, `demo-${id}`))
			.filter((item) => item !== null);
		store.update((draft) => {
			draft.mode = "rotation";
			draft.playlist = playlist;
			draft.cursor = 0;
			draft.remaining = [];
			draft.paused = false;
			draft.schedule = { ...draft.schedule, mode: "hourly", order: "sequential", atMinutes: [0] };
			return draft;
		});
		store.save();
		engine.reschedule();
		engine.goTo(0, true);
		refresh();
	}

	function setTab(name) {
		for (const node of $("pg-tabs").querySelectorAll("button")) {
			node.classList.toggle("is-on", node.dataset.tab === name);
		}
		for (const id of ["panel", "sched", "diag"]) {
			const section = $(`pg-tab-${id}`);
			if (section !== null) section.hidden = id !== name;
		}
	}

	function wireControls() {
		const missing = REQUIRED_IDS.filter((id) => $(id) === null);
		if (missing.length > 0) {
			// Surfaces in the warning panel below, where the person looking at the
			// page will actually see it.
			console.warn(`[preview] index.html 缺少 ${missing.length} 个元素 id：${missing.join(", ")}`);
		}
		$("pg-tabs").addEventListener("click", (event) => {
			const target = event.target.closest("button[data-tab]");
			if (target !== null) setTab(target.dataset.tab);
		});
		$("pg-clock-apply").addEventListener("click", () => {
			const minutes = Number($("pg-clock-input").value);
			P.advanceClock((Number.isFinite(minutes) ? minutes : 0) * 60 * 1000);
			catchUp();
			refresh();
		});
		$("pg-clock-reset").addEventListener("click", () => {
			P.shiftClock(0);
			catchUp();
			refresh();
		});
		$("pg-demo").addEventListener("click", seedRotationDemo);
		$("pg-reboot").addEventListener("click", () => boot(preview.lang));
		$("pg-dispose").addEventListener("click", () => {
			disposeBoot();
			refresh();
		});
		renderThemeButtons();
		renderLangButtons();
		renderClockButtons();
	}

	// ── readouts ─────────────────────────────────────────────────────────────
	function renderWarnings() {
		const log = $("pg-log");
		if (log !== null) {
			const text = warnings.join("\n");
			if (log.textContent !== text) log.textContent = text;
		}
		setText("pg-warn-count", `${warnings.length} 条`);
	}

	function describeSchedule(schedule) {
		if (schedule.mode === "interval") return `每 ${schedule.intervalMin} 分钟`;
		if (schedule.mode === "hourly") return `每小时的第 ${schedule.atMinutes.join(" / ")} 分`;
		if (schedule.mode === "daily") return `每天 ${schedule.atTime}`;
		return "每次新会话";
	}

	function renderTimeline(triggers, now) {
		const signature = triggers.join(",");
		if (signature === timelineSignature) return;
		timelineSignature = signature;
		const host = $("pg-timeline");
		host.textContent = "";
		if (triggers.length === 0) {
			const note = document.createElement("div");
			note.className = "pg-note";
			note.textContent = "这个模式没有未来的触发点——`session` 模式下一次换图发生在下一个新会话。";
			host.appendChild(note);
			return;
		}
		let widest = 1;
		const gaps = triggers.map((ts, index) => {
			const gap = Math.max(0, ts - (index === 0 ? now : triggers[index - 1]));
			if (gap > widest) widest = gap;
			return gap;
		});
		triggers.forEach((ts, index) => {
			const row = document.createElement("div");
			row.className = `pg-timeline-row${index === 0 ? " is-next" : ""}`;
			const bar = document.createElement("span");
			bar.className = "pg-timeline-bar";
			bar.style.width = `${Math.max(3, Math.round((gaps[index] / widest) * 96))}px`;
			const when = document.createElement("span");
			when.className = "pg-timeline-stamp";
			when.textContent = stamp(ts, true);
			const away = document.createElement("span");
			away.className = "pg-timeline-in";
			away.textContent = `+${humanDuration(ts - now)}`;
			row.appendChild(bar);
			row.appendChild(when);
			row.appendChild(away);
			host.appendChild(row);
		});
	}

	function refreshClock() {
		const realNow = P.RealDate.now();
		const pluginNow = Date.now();
		const offset = pluginNow - realNow;
		setText("k-clock-real", stamp(realNow, true));
		setText("k-clock-plugin", stamp(pluginNow, true));
		setValue(
			"k-clock-offset",
			offset === 0 ? "0（与真实时间一致）" : `${offset > 0 ? "+" : "−"}${humanDuration(Math.abs(offset))}`,
			offset === 0 ? null : "warn"
		);
	}

	function refreshSchedule(state, now) {
		const live = state.mode === "rotation" && state.paused !== true;
		setText("k-sched-mode", state.mode === "rotation" ? (state.paused ? "开启 · 已暂停" : "开启") : "关闭（单张）");
		setText("k-sched-kind", describeSchedule(scheduler.normalizeSchedule(state.schedule)));
		setText("k-sched-order", ORDER_LABEL[state.schedule.order] || state.schedule.order);

		if (state.nextAt > 0) {
			setText("k-sched-next", stamp(state.nextAt, true));
			const remaining = state.nextAt - now;
			setValue("k-sched-in", remaining > 0 ? humanDuration(remaining) : `已过期 ${humanDuration(-remaining)}`, remaining > 0 ? null : "warn");
		} else {
			setText("k-sched-next", live ? "（未安排）" : "—");
			setText("k-sched-in", "—");
		}

		const plan = scheduler.planResume(scheduler.normalizeSchedule(state.schedule), now, state.nextAt);
		setValue(
			"k-sched-plan",
			plan.due ? `到点 · 前进一格（跳过了 ${plan.missed} 次）` : "未到点",
			plan.due ? "warn" : null
		);

		if (state.playlist.length === 0) {
			setValue("k-sched-playlist", "空（轮播需要有内容）", state.mode === "rotation" ? "warn" : null);
		} else {
			const index = Math.min(Math.max(0, state.cursor), state.playlist.length - 1);
			setText("k-sched-playlist", `${state.playlist.length} 条 · 当前 #${index + 1} ${itemName(state.playlist[index])}`);
		}

		renderTimeline(live ? scheduler.upcomingTriggers(scheduler.normalizeSchedule(state.schedule), now, TIMELINE_COUNT) : [], now);
	}

	function refreshDiagnostics(api, now) {
		const store = api.store;
		const engine = api.engine;
		const state = store.getState();
		const health = store.getHealth();
		const inspect = engine.inspect();
		const published = window.__DSH_LUMEN__ || null;

		// ── lifecycle ──
		setValue(
			"k-status",
			published === null ? "未发布" : `${published.status}${published.warnings && published.warnings.length > 0 ? ` · ${published.warnings.length} 条告警` : ""}`,
			published !== null && published.status === "ready" ? "ok" : "warn"
		);
		setText("k-build", published === null ? "—" : published.build);
		setText("k-schema", published === null ? "—" : published.schema);
		const mounted = typeof api.panelMounted === "function" ? api.panelMounted() : false;
		setValue("k-panel", mounted ? "已挂载（React 桥接 → DOM 面板）" : "未挂载", mounted ? "ok" : "warn");
		setValue("k-dom", inspect.hasDom ? "根节点在位（z-index:-1）" : "无根节点", inspect.hasDom ? "ok" : null);
		setText("k-motion", inspect.reducedMotion ? "reduce —— 交叉淡入已关闭" : "正常 —— 交叉淡入开启");

		// ── the picture and the wash ──
		const item = inspect.activeItem;
		setText("k-item", itemName(item));
		setText("k-item-kind", item === null ? "—" : KIND_LABEL[item.kind] || item.kind);
		const chosen = state.wash.opacity;
		const required = inspect.requiredAlpha;
		const effective = Math.max(chosen, required);
		setText("k-wash-chosen", `${Math.round(chosen * 1000) / 10}%`);
		setText("k-wash-required", item === null ? "—" : `${Math.round(required * 1000) / 10}%`);
		setValue(
			"k-wash-effective",
			`${Math.round(effective * 1000) / 10}%`,
			required > chosen + 0.0005 ? "warn" : "ok"
		);
		setText("k-wash-autodim", state.wash.autoDim ? "开（按配方复杂度再加 0–12%）" : "关");
		setValue(
			"k-wash-readability",
			state.wash.readability ? "开 · 下限 4.5:1，只抬不降" : "关 · 下限已取消（正文可能不可读）",
			state.wash.readability ? "ok" : "warn"
		);

		// ── persistence ──
		setValue(
			"k-host",
			health.hostAvailable ? `可用 · POST ${API_PATH}` : `不可用 · ${health.hostReason || "unknown"}`,
			health.hostAvailable ? "ok" : "warn"
		);
		setText("k-host-keys", preview.hostInfo === null ? "—（无法读取，可能未通过预览服务器打开）" : `${preview.hostInfo.keys} 个键`);
		setText("k-seed", health.hasStorage ? "可用 · localStorage 种子（首屏同步绘制）" : "不可用 · 无 localStorage");
		setText(
			"k-state-file",
			preview.hostInfo === null ? "—" : `${preview.hostInfo.file} · ${preview.hostInfo.bytes} B`
		);
		setValue("k-last-error", health.lastError || "（无）", health.lastError ? "warn" : null);

		// ── tokens: raw vs composed, which is the only honest way to show that the
		// plugin touches exactly two of them ──
		const theme = preview.boot.ctx.theme;
		const raw = theme.rawTokens();
		const composed = theme.visibleTokens();
		const changed = Object.keys(composed).filter((name) => raw[name] !== composed[name]);
		setText("k-theme", `${theme.getTheme().preference} → ${theme.getTheme().active.id} · ${theme.isDark() ? "dark" : "light"}`);
		setText("k-token-raw", raw["--dsw-alias-bg-base"]);
		setValue("k-token-washed", composed["--dsw-alias-bg-base"], changed.length > 0 ? "warn" : null);
		setText("k-override-sources", theme.overrideSources().join(", ") || "（无）");
		setValue(
			"k-override-tokens",
			changed.length === 0 ? "（无）" : `${changed.length} 枚：${changed.join("  ")}`,
			changed.length === 2 ? "ok" : "warn"
		);
		setText("k-slots", preview.boot.ctx.slots.names().join(", ") || "（无）");
		setText("k-locales", preview.boot.ctx.locale.namespaces().join(", ") || "（无）");

		setText("pg-sched-source", `scheduler.planResume · now = ${stamp(now, false)}`);
	}

	function refresh() {
		refreshClock();
		const boot_ = preview.boot;
		if (boot_ === null || boot_.api === null) {
			for (const id of REQUIRED_IDS) {
				if (id.slice(0, 2) === "k-") setText(id, "已卸载");
			}
			setValue("k-status", "已卸载（dispose 已执行）", "warn");
			renderTimeline([], Date.now());
			const badge = $("pg-status-badge");
			if (badge !== null) badge.textContent = "disposed";
			renderWarnings();
			return;
		}
		const now = Date.now();
		refreshSchedule(boot_.api.store.getState(), now);
		refreshDiagnostics(boot_.api, now);
		const badge = $("pg-status-badge");
		if (badge !== null) badge.textContent = window.__DSH_LUMEN__ ? window.__DSH_LUMEN__.status : "unknown";
		renderWarnings();
	}

	// ── host poll: the durable file's identity, straight from the server ──────
	async function pollHost() {
		try {
			const response = await fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ method: "ping" })
			});
			const payload = await response.json();
			preview.hostInfo = payload && payload.ok === true ? payload.value : null;
		} catch {
			// Opened from `file://`, or without scripts/serve.cjs. The plugin's own
			// degradation path already reports this; here it is only the preview's
			// copy of the answer.
			preview.hostInfo = null;
		}
	}

	// ── go ───────────────────────────────────────────────────────────────────
	wireControls();
	setTab("panel");
	boot("zh");
	refresh();
	pollHost().then(refresh);
	setInterval(refresh, REFRESH_MS);
	setInterval(() => {
		pollHost().then(refresh);
	}, HOST_POLL_MS);

	// Exposed so the browser console can drive the same levers the buttons do.
	window.__DSH_LUMEN_PREVIEW__.control = {
		boot,
		dispose: () => {
			disposeBoot();
			refresh();
		},
		refresh,
		seedRotationDemo,
		catchUp,
		warnings: () => warnings.slice()
	};
})();
