/** Maximum turn duration (ms) for a resume attempt to qualify as a stale-session failure. */
export const STALE_SESSION_DETECTION_THRESHOLD_MS = 5_000;
export const CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS = 3_000;
export const CODEX_DISCOVERY_REFRESH_TTL_MS = 60_000;
export const CODEX_MISSING_ROLLOUT_ERROR_RE =
  /\bno rollout found for thread id\b/i;
export const PLUGIN_PROVIDER_SUPPORT_INDEX_TTL_MS = 5_000;
/**
 * Oldest (ms) an in-memory provider-support index may be and still be accepted
 * as a fallback when a refresh fails.
 *
 * The module cache never expires on its own — it holds the last successful load
 * for the life of the renderer — so a caller that falls back to it needs its own
 * bound. Five minutes keeps the case the fallback exists for (a transient
 * marketplace hiccup seconds after a good load) and refuses anything older.
 *
 * SCOPE, precisely: this bounds how long we will trust an index THIS RENDERER
 * already loaded after a refresh has failed. It is NOT a claim that the
 * marketplace inventory is fresh. `loadMarketplaces` serves a v2 disk cache and
 * preserves its `lastRefreshed`, and provider updates are themselves gated
 * behind a 24h stamp, so the inventory behind even a brand-new load is routinely
 * a day old. Re-basing this bound on `PluginsCache.lastRefreshed` would
 * therefore refuse nearly every plugin-carrying continue rather than tighten
 * anything. Inventory freshness is the marketplace refresh cycle's job; this
 * constant only stops a long-lived renderer from answering a compatibility
 * question from a snapshot it took hours ago.
 */
export const PLUGIN_PROVIDER_SUPPORT_INDEX_MAX_FALLBACK_AGE_MS = 300_000;
/**
 * Upper bound (ms) on the cross-harness handoff summary request.
 *
 * The continue confirm dialog disables Cancel, Escape and backdrop dismissal
 * while the request is in flight, and the main-process helper exposes no abort
 * signal, so an unbounded await is a dialog the user cannot escape.
 *
 * NOTE: the continue flow's bounded steps run SEQUENTIALLY, so the worst-case
 * uncancellable dialog is the SUM of this and every other step bound below —
 * not this value alone. Adding a third bounded step raises that ceiling again.
 */
export const HANDOFF_SUMMARY_TIMEOUT_MS = 120_000;

/**
 * Upper bound (ms) on the plugin-provider-support index load in the continue
 * flow. Much shorter than the summary bound: the normal case is a warm in-memory
 * cache, and the slow path is a local marketplace refresh rather than a model
 * call, so a long wait here is a hang rather than legitimate work.
 */
export const PLUGIN_SUPPORT_INDEX_TIMEOUT_MS = 20_000;
export const TERMINAL_BRACKETED_PASTE_START = '\x1b[200~';
export const TERMINAL_BRACKETED_PASTE_END = '\x1b[201~';
export const TERMINAL_ENTER_KEY = '\r';
/**
 * How long (ms) after a renderer reload we may preserve a tab's
 * `status: 'streaming'` when `activeChatIds` is empty but a matching
 * main-process session still shows recent nonterminal activity.
 *
 * This grace window protects just-crashed tabs from being stamped
 * `Completed` prematurely. Beyond this window, the tab settles to idle
 * and open turn timers / tool uses are closed as usual.
 */
export const SESSION_RESTORE_GRACE_MS = 30_000;
