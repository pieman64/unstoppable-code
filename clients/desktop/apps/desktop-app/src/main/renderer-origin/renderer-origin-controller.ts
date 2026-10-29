import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RENDERER_SCHEME_ORIGIN,
  isRendererSchemeUrl,
} from '@canopy/desktop-shared/lib/renderer-scheme';
import {
  APP_ADVISOR_RENDERER_PAGE,
  APP_ADVISOR_RENDERER_SEARCH,
  MAIN_WINDOW_RENDERER_PAGE,
} from '../lib/renderer-pages';
import {
  fallBackToFileOrigin,
  prepareRendererLaunchOrigin,
  type OriginStorageBridge,
  type RendererOrigin,
  type RendererOriginMigrationOutcome,
  type RendererOriginRecord,
  type RendererOriginRecordStore,
} from './renderer-origin-migration';
import type { RendererCodeCacheSchemeStatus } from './renderer-code-cache-scheme-status';

/**
 * Per-launch owner of the renderer's origin: `file://` (today's path) or
 * the renderer scheme, behind Settings → Labs → "Open windows
 * faster" (`rendererCodeCacheSchemeEnabled`).
 *
 * - `prepare` runs once, before the first window, and moves origin-keyed
 *   storage when the origin changed since the last launch. With the
 *   setting off on an install that never opted in it does nothing.
 * - `loadWindow` loads every app window, on either origin. It first waits
 *   for `prepare` and for any fallback in flight, so no window loads on an
 *   origin whose storage copy has not finished, and none is open on
 *   `file://` while a copy replaces that origin's storage. Over the scheme
 *   it arms the fail-safe.
 * - The fail-safe: a main frame that fails to load, a rejected load, a
 *   handler error, a renderer process that dies before its page was ready
 *   (or dies again before it recovered), a page that never finishes
 *   loading, or a `#root` that stays empty after loading. Every scheme
 *   window is blanked, storage is copied back to `file://`, the setting is
 *   turned off, and the windows load their `file://` pages. The fallback
 *   turns the setting off because a failure to load is most likely
 *   deterministic (a damaged bundle or an unsupported platform); retrying
 *   every launch would pay two storage copies per launch. The user can turn
 *   it back on in Settings.
 * - `trustedRendererPageUrls` names the two pages IPC trusts: the scheme's
 *   while scheme pages may still be live, then `file://`'s.
 */

export type RendererWindowSurface = 'main' | 'app-advisor';

export interface RendererLoadableContents {
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(event: 'did-finish-load', listener: () => void): unknown;
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string }) => void,
  ): unknown;
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  forcefullyCrashRenderer(): void;
}

export interface RendererLoadableWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { search?: string }): Promise<void>;
  webContents: RendererLoadableContents;
}

export interface RendererWindowTarget {
  surface: RendererWindowSurface;
  window: RendererLoadableWindow;
}

export type RendererOriginFallbackReason =
  | 'did-fail-load'
  | 'load-rejected'
  | 'handler-error'
  | 'renderer-gone'
  | 'renderer-not-ready';

export type RendererOriginDiagnostic =
  | {
      kind: 'migrated';
      from: RendererOrigin;
      to: RendererOrigin;
      outcome: RendererOriginMigrationOutcome;
      keyCount: number;
      indexedDbCount: number;
    }
  | {
      kind: 'migration-failed';
      from: RendererOrigin;
      to: RendererOrigin;
      error: string;
    }
  | {
      kind: 'fallback';
      reason: RendererOriginFallbackReason;
      detail?: string;
      storageMigrated: boolean;
    };

export interface RendererOriginControllerOptions {
  /** The renderer output directory `loadFile` uses. */
  rendererDir: string;
  store: RendererOriginRecordStore;
  createBridge: () => OriginStorageBridge;
  registerSchemeHandler: (options: {
    rootDir: string;
    onError: (error: unknown) => void;
  }) => void;
  /** Loads a window's `file://` page: today's `loadFile` call. */
  loadFile: (target: RendererWindowTarget) => Promise<void>;
  /** Persists `rendererCodeCacheSchemeEnabled: false`. */
  disableSetting: () => Promise<void>;
  /** Persists `rendererCodeCacheSchemeEnabled: true`. */
  reenableSetting: () => Promise<void>;
  recordDiagnostic: (event: RendererOriginDiagnostic) => void;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
  /** How long the fallback waits for a scheme window to blank. */
  blankTimeoutMs?: number;
  now?: () => Date;
}

export interface RendererOriginController {
  /** Starts reading the record early, off the startup critical path. */
  startRecordProbe(): void;
  /** Decides this launch's origin; call once before the first window. */
  prepare(schemeEnabled: boolean): Promise<RendererOrigin>;
  current(): RendererOrigin;
  /**
   * Loads a window on this launch's origin once no origin change is in
   * flight; over the scheme it arms the fail-safe for it.
   */
  loadWindow(target: RendererWindowTarget): Promise<void>;
  trustedRendererPageUrls(): string[];
  status(): RendererCodeCacheSchemeStatus;
  /** True while a fallback is blanking, copying or reloading windows. */
  fallbackInProgress(): boolean;
  /** Resolves once a fallback in progress has finished. */
  whenSettled(): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 250;
const DEFAULT_BLANK_TIMEOUT_MS = 5_000;

/** Whether `promise` settles, either way, within `ms`. */
function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(settle, settle);
  });
}
const ERR_ABORTED = -3;

/** How many elements React rendered into the page's root, or 0. */
const ROOT_PROBE_SCRIPT =
  "document.getElementById('root')?.childElementCount ?? 0";

function pageFor(surface: RendererWindowSurface): string {
  return surface === 'main'
    ? MAIN_WINDOW_RENDERER_PAGE
    : APP_ADVISOR_RENDERER_PAGE;
}

/** The URL a window loads over the scheme. */
export function rendererSchemePageUrl(surface: RendererWindowSurface): string {
  const page = `${RENDERER_SCHEME_ORIGIN}/${pageFor(surface)}`;
  return surface === 'app-advisor'
    ? `${page}${APP_ADVISOR_RENDERER_SEARCH}`
    : page;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortedLoad(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (
    Reflect.get(error, 'errno') === ERR_ABORTED ||
    Reflect.get(error, 'code') === 'ERR_ABORTED'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createRendererOriginController(
  options: RendererOriginControllerOptions,
): RendererOriginController {
  const now = options.now ?? ((): Date => new Date());
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyPollIntervalMs =
    options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
  const blankTimeoutMs = options.blankTimeoutMs ?? DEFAULT_BLANK_TIMEOUT_MS;

  let origin: RendererOrigin = 'file';
  /** The origin whose pages IPC trusts; lags `origin` during a fallback. */
  let trustedOrigin: RendererOrigin = 'file';
  let fellBack = false;
  let switchBackFailed = false;
  let record: RendererOriginRecord | null = null;
  let probe: Promise<RendererOriginRecord | null> | null = null;
  let handlerRegistered = false;
  let fallback: Promise<void> | null = null;
  let fallbackRunning: Promise<void> | null = null;
  let markPrepared: () => void = () => undefined;
  // Every window load waits for this launch's origin decision. Only
  // non-dev launches load through the controller, and they all call
  // `prepare` before the first window.
  const prepared = new Promise<void>((resolve) => {
    markPrepared = resolve;
  });
  const schemeTargets = new Map<RendererLoadableWindow, RendererWindowTarget>();
  const watched = new WeakSet<RendererLoadableContents>();
  const ready = new WeakSet<RendererLoadableContents>();
  const readyGeneration = new WeakMap<RendererLoadableContents, number>();

  const readRecord = (): Promise<RendererOriginRecord | null> =>
    options.store.read().catch(() => null);

  function registerHandlerOnce(): void {
    if (handlerRegistered) return;
    handlerRegistered = true;
    options.registerSchemeHandler({
      rootDir: options.rendererDir,
      onError: (error) => {
        void fallBack('handler-error', describe(error));
      },
    });
  }

  /**
   * The bridge, or one whose every call rejects when it cannot be created,
   * so the fallback still records `file://` as authoritative and reloads.
   */
  function createBridgeOrUnavailable(): OriginStorageBridge {
    try {
      return options.createBridge();
    } catch (error) {
      const unavailable = (): Promise<never> =>
        Promise.reject(
          error instanceof Error ? error : new Error(describe(error)),
        );
      return {
        read: unavailable,
        replace: unavailable,
        update: unavailable,
        flush: unavailable,
        abort: () => undefined,
      };
    }
  }

  function fallBack(
    reason: RendererOriginFallbackReason,
    detail?: string,
  ): Promise<void> {
    if (fallback) return fallback;
    if (origin !== 'scheme') return Promise.resolve();
    origin = 'file';
    fellBack = true;
    const run = (async (): Promise<void> => {
      try {
        const targets = Array.from(schemeTargets.values()).filter(
          (target) => !target.window.isDestroyed(),
        );
        // Stop the app on the scheme before copying its storage, so nothing
        // writes to it during the copy. A window that is not verifiably on
        // about:blank afterwards (the navigation failed, or the renderer is
        // too hung to finish it in time) has its renderer stopped instead;
        // the window reloads on file:// afterwards.
        for (const target of targets) {
          await settlesWithin(
            target.window.loadURL('about:blank'),
            blankTimeoutMs,
          );
          const contents = target.window.webContents;
          if (!contents.isDestroyed() && contents.getURL() !== 'about:blank') {
            contents.forcefullyCrashRenderer();
          }
        }
        trustedOrigin = 'file';
        await options.disableSetting().catch(() => undefined);
        const result = await fallBackToFileOrigin({
          record,
          store: options.store,
          bridge: createBridgeOrUnavailable(),
          createBridge: createBridgeOrUnavailable,
          reason,
          now,
        });
        record = result.record;
        schemeTargets.clear();
        for (const target of targets) {
          if (target.window.isDestroyed()) continue;
          await options.loadFile(target).catch(() => undefined);
        }
        options.recordDiagnostic({
          kind: 'fallback',
          reason,
          ...(detail ? { detail } : {}),
          storageMigrated: result.migrated,
        });
      } finally {
        trustedOrigin = 'file';
        fallbackRunning = null;
      }
    })();
    fallback = run;
    fallbackRunning = run;
    return run;
  }

  function nextGeneration(contents: RendererLoadableContents): number {
    const generation = (readyGeneration.get(contents) ?? 0) + 1;
    readyGeneration.set(contents, generation);
    return generation;
  }

  function isStale(
    contents: RendererLoadableContents,
    generation: number,
  ): boolean {
    return (
      origin !== 'scheme' ||
      contents.isDestroyed() ||
      readyGeneration.get(contents) !== generation
    );
  }

  /** Falls back if the page has not finished loading in time. */
  function armLoadWatchdog(contents: RendererLoadableContents): void {
    const generation = nextGeneration(contents);
    const timer = setTimeout(() => {
      if (isStale(contents, generation)) return;
      void fallBack('renderer-not-ready', 'The page did not finish loading.');
    }, readyTimeoutMs);
    timer.unref();
  }

  /** Polls `#root` until React rendered into it, or falls back. */
  async function checkReady(contents: RendererLoadableContents): Promise<void> {
    const generation = nextGeneration(contents);
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
    }, readyTimeoutMs);
    deadline.unref();
    try {
      while (!expired) {
        if (isStale(contents, generation)) return;
        // A hung renderer never answers; count that as not ready yet.
        const children = await Promise.race([
          contents.executeJavaScript(ROOT_PROBE_SCRIPT).catch(() => 0),
          delay(readyPollIntervalMs).then(() => 0),
        ]);
        if (typeof children === 'number' && children > 0) {
          ready.add(contents);
          return;
        }
        if (!expired) await delay(readyPollIntervalMs);
      }
    } finally {
      clearTimeout(deadline);
    }
    if (!isStale(contents, generation)) await fallBack('renderer-not-ready');
  }

  function watch(target: RendererWindowTarget): void {
    const contents = target.window.webContents;
    if (watched.has(contents)) return;
    watched.add(contents);
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (
          !isMainFrame ||
          errorCode === ERR_ABORTED ||
          origin !== 'scheme' ||
          !isRendererSchemeUrl(validatedURL)
        ) {
          return;
        }
        void fallBack(
          'did-fail-load',
          `${errorDescription} (${String(errorCode)})`,
        );
      },
    );
    contents.on('did-finish-load', () => {
      if (origin !== 'scheme' || contents.isDestroyed()) return;
      if (!isRendererSchemeUrl(contents.getURL())) return;
      ready.delete(contents);
      void checkReady(contents);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || origin !== 'scheme') return;
      if (!schemeTargets.has(target.window)) return;
      // A page that was working gets the window's normal recovery reload
      // once; a renderer that dies before its page was ready, or again
      // before it recovered, cannot run the app over the scheme.
      if (ready.has(contents)) {
        ready.delete(contents);
        return;
      }
      void fallBack('renderer-gone', details.reason);
    });
  }

  async function decide(schemeEnabled: boolean): Promise<RendererOrigin> {
    const current = await (probe ?? readRecord());
    let decision: Awaited<ReturnType<typeof prepareRendererLaunchOrigin>>;
    try {
      decision = await prepareRendererLaunchOrigin({
        schemeEnabled,
        record: current,
        store: options.store,
        createBridge: options.createBridge,
        registerHandler: registerHandlerOnce,
        now,
      });
    } catch (error) {
      // Never block the first window: an unexpected failure keeps this
      // launch on today's file:// path.
      origin = 'file';
      options.recordDiagnostic({
        kind: 'migration-failed',
        from: current?.lastUsedOrigin ?? 'file',
        to: schemeEnabled ? 'scheme' : 'file',
        error: describe(error),
      });
      if (schemeEnabled) {
        fellBack = true;
        await options.disableSetting().catch(() => undefined);
      }
      return origin;
    }
    record = decision.record;
    origin = decision.origin;
    trustedOrigin = decision.origin;
    if (decision.migration) {
      options.recordDiagnostic({
        kind: 'migrated',
        from: decision.migration.from,
        to: decision.migration.to,
        outcome: decision.migration.outcome,
        keyCount: decision.migration.keyCount,
        indexedDbCount: decision.migration.indexedDbNames.length,
      });
    }
    if (decision.migrationError !== undefined) {
      options.recordDiagnostic({
        kind: 'migration-failed',
        from: current?.lastUsedOrigin ?? 'file',
        to: schemeEnabled ? 'scheme' : 'file',
        error: describe(decision.migrationError),
      });
    }
    if (decision.disableSetting) {
      fellBack = true;
      await options.disableSetting().catch(() => undefined);
    }
    if (decision.reenableSetting) {
      switchBackFailed = true;
      await options.reenableSetting().catch(() => undefined);
    }
    return origin;
  }

  return {
    startRecordProbe(): void {
      probe ??= readRecord();
    },

    async prepare(schemeEnabled: boolean): Promise<RendererOrigin> {
      try {
        return await decide(schemeEnabled);
      } finally {
        markPrepared();
      }
    },

    current: (): RendererOrigin => origin,

    async loadWindow(target: RendererWindowTarget): Promise<void> {
      await prepared;
      while (fallbackRunning) await fallbackRunning;
      // From here to the load starting, nothing else runs.
      if (target.window.isDestroyed()) return;
      if (origin !== 'scheme') {
        await options.loadFile(target);
        return;
      }
      watch(target);
      schemeTargets.set(target.window, target);
      armLoadWatchdog(target.window.webContents);
      try {
        await target.window.loadURL(rendererSchemePageUrl(target.surface));
      } catch (error) {
        if (!isAbortedLoad(error))
          void fallBack('load-rejected', describe(error));
      }
    },

    trustedRendererPageUrls(): string[] {
      const pages = [MAIN_WINDOW_RENDERER_PAGE, APP_ADVISOR_RENDERER_PAGE];
      return trustedOrigin === 'scheme'
        ? pages.map((page) => `${RENDERER_SCHEME_ORIGIN}/${page}`)
        : pages.map(
            (page) => pathToFileURL(join(options.rendererDir, page)).href,
          );
    },

    status: (): RendererCodeCacheSchemeStatus => ({
      active: origin === 'scheme',
      fellBack,
      switchBackFailed,
    }),

    fallbackInProgress: (): boolean => fallbackRunning !== null,

    whenSettled: (): Promise<void> => fallback ?? Promise.resolve(),
  };
}
