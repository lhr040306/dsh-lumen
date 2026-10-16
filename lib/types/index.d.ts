/**
 * Type declarations for the host half of `dsh-lumen`.
 *
 * The host half exists for exactly one reason: DSH Desktop binds its web server
 * to an OS-assigned port on every launch, so `localStorage` — which is scoped
 * per origin — "forgets" the user's wallpaper on every restart. The durable copy
 * therefore lives in a file the host owns, reached through a fenced route.
 *
 * These declarations describe the cordis module contract and the shapes that
 * cross the wire. They are hand-written rather than generated, because the
 * interesting part of this module is what it *refuses* to do — refuse a
 * cross-site request, refuse a write that would not fit — and that intent has no
 * expression in a generated signature.
 */

/** cordis plugin name, matching `package.json` and `cordis.patch.yml`. */
export declare const name: "dsh-lumen";

/**
 * Host services the plugin waits for before `apply` runs.
 * `webServer` provides the route; `webRuntime` provides the state directory.
 */
export declare const inject: readonly ["webServer", "webRuntime"];

/** Storage key inside the state file holding the document's schema stamp. */
export declare const STATE_SCHEMA_KEY: "dsh-lumen:schema-version";

/** Schema version this build writes, as a decimal integer string. */
export declare const STATE_SCHEMA_VERSION: string;

/** A flat string map: the one shape the persistence API accepts. */
export type StateMap = Record<string, string>;

/** Why a request was refused, as a stable code the client can map to text. */
export type ApiErrorCode =
	| "bad-request"
	| "method-not-allowed"
	| "not-found"
	| "payload-too-large"
	| "state-too-large"
	| "too-many-keys"
	| "schema-too-new"
	| "untrusted-origin"
	| "internal";

/** The `{ method }` envelope every request body carries. */
export type ApiRequest =
	| { method: "ping" }
	| { method: "get" }
	/** A merge patch. A string sets, `null` deletes, an absent key is untouched. */
	| { method: "set"; patch: Record<string, string | null> };

/** A successful answer. */
export interface ApiSuccess<T> {
	ok: true;
	value: T;
}

/** A refused answer. */
export interface ApiFailure {
	ok: false;
	error: { code: ApiErrorCode; message: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/**
 * Register the plugin.
 *
 * Never throws: a wallpaper plugin must not be the reason DSH fails to boot, so
 * every service is probed and every failure degrades to "no wallpaper and one
 * log line" rather than to a failed activation.
 */
export declare function apply(ctx: HostContext): void;

/** The slice of the cordis host context this plugin uses. */
export interface HostContext {
	webServer: {
		/** Mount a route handler. */
		use(path: string, handler: (req: HttpRequest, res: HttpResponse) => unknown): unknown;
	};
	webRuntime: {
		/** Resolve a path inside the user's DSH home directory. */
		resolve(...segments: string[]): string;
	};
	/** Register a disposer that runs on unload. */
	effect(fn: () => void | (() => void), label?: string): unknown;
}

/** The request fields the trust fence inspects. */
export interface HttpRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, handler: (chunk?: unknown) => void): unknown;
	destroy?(): void;
}

/** The response methods the route uses. */
export interface HttpResponse {
	statusCode: number;
	setHeader(name: string, value: string): void;
	end(chunk?: string): void;
}
