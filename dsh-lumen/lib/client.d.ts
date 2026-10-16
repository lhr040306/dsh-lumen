/**
 * Type declarations for the browser half of `dsh-lumen`.
 *
 * This module is loaded by `dsh-client-modules` through
 * `window.__ModuleLoader__.load({ id, factory })`; the factory body is plain
 * CommonJS whose `require` resolves against a private table, falling through to
 * the shell's module table for platform seeds (`react`) only.
 *
 * The default export shape is therefore what the factory *returns*, not a
 * module namespace object. `__modules` is exposed for the standalone preview and
 * for tests that want one piece without booting the whole plugin; the host does
 * not use it.
 */

import type { State } from "./types/internal";

/** cordis client context. Every field is probed before use. */
export interface ClientContext {
	/** Theme service: read the raw tokens, publish the wash. */
	theme?: {
		getTheme(): ThemeSnapshot | null;
		overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void;
	};
	/** Slot service: register the settings section and its body. */
	slots?: {
		inject(name: string, factory: () => unknown): unknown;
		register(options: Record<string, unknown>, component: unknown): unknown;
	};
	/** Locale service: publish the dictionary under {@link NS}. */
	locale?: {
		getLanguage?(): string;
		register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
	};
	/** Register a disposer that runs on unload. */
	effect?(fn: () => void | (() => void), label?: string): unknown;
	/** Subscribe to an event (`theme/change` is the one used). */
	on?(name: string, handler: () => void): unknown;
}

/** The raw theme view the engine reads. */
export interface ThemeSnapshot {
	preference?: string;
	themes?: Array<{ id: string; colorScheme?: string; tokens?: Record<string, string> }>;
	active?: { id?: string; tokens?: Record<string, string> };
}

/** What `apply` returns, for diagnostics and teardown in tests. */
export interface PluginHandle {
	store: unknown;
	engine: unknown;
	panelMounted(): boolean;
}

/**
 * Mount the plugin: persistence, the page, the settings UI and the host
 * services. Never throws — the wallpaper is best-effort, and a thrown entry
 * factory would take the whole web shell down with it.
 */
export declare function apply(ctx: ClientContext): PluginHandle;

/** Services to wait for before `apply` runs. */
export declare const inject: readonly ["slots", "locale", "theme"];

/** The fenced host persistence route, absolute on the current origin. */
export declare const API_PATH: "/lumen/api";

/** Settings section id. */
export declare const SECTION_ID: "lumen";

/** Slot that carries the settings panel body. */
export declare const ITEM_SLOT: "settings.lumen.item";

/** Global carrying the read-only diagnostics snapshot. */
export declare const STATUS_GLOBAL: "__DSH_LUMEN__";

/** Locale namespace the dictionary is registered under. */
export declare const NS: "settings.lumen";

/** Human-readable build stamp, published in the diagnostics snapshot. */
export declare const PLUGIN_BUILD: string;

/** Exposed for the preview and for tests. Not used by the host. */
export declare const __modules: {
	wallpapers: Record<string, unknown>;
	scheduler: Record<string, unknown>;
	state: Record<string, unknown>;
	engine: Record<string, unknown>;
	store: Record<string, unknown>;
	panel: Record<string, unknown>;
};

export type { State };
