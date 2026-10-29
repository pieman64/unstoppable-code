import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RENDERER_SCHEME_ORIGIN } from '@canopy/desktop-shared/lib/renderer-scheme';
import type {
  OriginStorageBridge,
  OriginStorageChanges,
  OriginStorageSnapshot,
  RendererOrigin,
} from './renderer-origin-migration';
import { RENDERER_STORAGE_BRIDGE_PAGE } from './renderer-scheme-handler';

/**
 * The narrowly scoped trusted host adapter that moves storage between the
 * renderer's two origins. Page script cannot read another origin, so main
 * opens a throwaway page *of* each origin and evaluates fixed code in it:
 *
 * - the page is `storage-bridge.html`, a static, script-free document
 *   (bundled for `file://`, served from memory by the scheme handler);
 * - its web contents are unattached, sandboxed, context-isolated, without
 *   a preload or Node, deny every `window.open` and every navigation, and
 *   are never an IPC-trusted app window;
 * - main evaluates only the scripts below; values cross as JSON string
 *   literals, never as code;
 * - each operation gets a fresh page that is always closed, and is bounded
 *   by a timeout;
 * - `abort()` closes the open page and refuses all later work, and a write
 *   script is only sent while the bridge is not aborted, so a copy that
 *   timed out cannot write afterwards.
 */

/** The parts of an Electron `WebContents` the bridge uses. */
export interface BridgeContents {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }) => void,
  ): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface OriginStorageBridgeOptions {
  /** The renderer output directory that holds the bundled bridge page. */
  rendererDir: string;
  createContents: () => BridgeContents;
  /** Writes buffered DOM storage of the app's session to disk. */
  flushStorage: () => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Reads every localStorage entry and the IndexedDB database names. */
export const READ_ORIGIN_STORAGE_SCRIPT = `(async () => {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  let indexedDbNames = [];
  try {
    const databases = await indexedDB.databases();
    indexedDbNames = databases
      .map((database) => database.name)
      .filter((name) => typeof name === 'string');
  } catch {
    indexedDbNames = [];
  }
  return JSON.stringify({ localStorage: entries, indexedDbNames });
})()`;

/**
 * Clears the origin's localStorage and writes exactly `entries`. The data
 * is embedded as a JSON string literal and parsed in the page, so no value
 * is ever evaluated as code.
 */
export function buildReplaceOriginStorageScript(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const payload = JSON.stringify(JSON.stringify(entries));
  return `(() => {
  const entries = JSON.parse(${payload});
  localStorage.clear();
  for (const [key, value] of entries) localStorage.setItem(key, value);
  return localStorage.length;
})()`;
}

/**
 * Removes and sets only the given keys, leaving every other key as it was.
 * If a write throws (a full origin, for example), the script puts back every
 * key it already changed before it rethrows, so the origin is unchanged.
 */
export function buildUpdateOriginStorageScript(
  changes: OriginStorageChanges,
): string {
  const payload = JSON.stringify(JSON.stringify(changes));
  return `(() => {
  const changes = JSON.parse(${payload});
  const changed = [];
  const write = (key, value) => {
    changed.push([key, localStorage.getItem(key)]);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  };
  try {
    for (const key of changes.remove) write(key, null);
    for (const [key, value] of changes.set) write(key, value);
  } catch (error) {
    for (const [key, value] of changed.reverse()) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw error;
  }
  return localStorage.length;
})()`;
}

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/** Validates the read script's result; throws on anything unexpected. */
export function parseOriginStorageSnapshot(
  raw: unknown,
): OriginStorageSnapshot {
  if (typeof raw !== 'string') {
    throw new Error('The storage bridge returned no snapshot.');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The storage bridge returned an invalid snapshot.');
  }
  const localStorage: unknown = Reflect.get(parsed, 'localStorage');
  const indexedDbNames: unknown = Reflect.get(parsed, 'indexedDbNames');
  if (
    !Array.isArray(localStorage) ||
    !localStorage.every(isStringPair) ||
    !Array.isArray(indexedDbNames) ||
    !indexedDbNames.every((name) => typeof name === 'string')
  ) {
    throw new Error('The storage bridge returned an invalid snapshot.');
  }
  return {
    localStorage: localStorage.map(([key, value]) => [key, value]),
    indexedDbNames: indexedDbNames.map(String),
  };
}

/** The bridge page on `origin`. */
export function storageBridgePageUrl(
  origin: RendererOrigin,
  rendererDir: string,
): string {
  return origin === 'file'
    ? pathToFileURL(join(rendererDir, RENDERER_STORAGE_BRIDGE_PAGE)).href
    : `${RENDERER_SCHEME_ORIGIN}/${RENDERER_STORAGE_BRIDGE_PAGE}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The storage bridge timed out: ${label}.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function stopped(): Error {
  return new Error('The storage bridge was stopped.');
}

export function createOriginStorageBridge(
  options: OriginStorageBridgeOptions,
): OriginStorageBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let aborted = false;
  let open: BridgeContents | null = null;

  async function onOriginPage<T>(
    origin: RendererOrigin,
    run: (contents: BridgeContents) => Promise<T>,
  ): Promise<T> {
    if (aborted) throw stopped();
    const contents = options.createContents();
    open = contents;
    try {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => {
        event.preventDefault();
      });
      await withTimeout(
        contents.loadURL(storageBridgePageUrl(origin, options.rendererDir)),
        timeoutMs,
        `loading the ${origin} page`,
      );
      if (aborted) throw stopped();
      return await withTimeout(run(contents), timeoutMs, `${origin} storage`);
    } finally {
      if (open === contents) open = null;
      if (!contents.isDestroyed()) contents.close();
    }
  }

  return {
    read: (origin) =>
      onOriginPage(origin, async (contents) =>
        parseOriginStorageSnapshot(
          await contents.executeJavaScript(READ_ORIGIN_STORAGE_SCRIPT, false),
        ),
      ),
    replace: (origin, entries) =>
      onOriginPage(origin, async (contents) => {
        // Checked in the same task that sends the script.
        if (aborted) throw stopped();
        const count = await contents.executeJavaScript(
          buildReplaceOriginStorageScript(entries),
          false,
        );
        if (count !== entries.length) {
          throw new Error('The storage bridge wrote an unexpected key count.');
        }
      }),
    update: (origin, changes) =>
      onOriginPage(origin, async (contents) => {
        // Checked in the same task that sends the script.
        if (aborted) throw stopped();
        await contents.executeJavaScript(
          buildUpdateOriginStorageScript(changes),
          false,
        );
      }),
    flush: (): Promise<void> => {
      options.flushStorage();
      return Promise.resolve();
    },
    abort: (): void => {
      aborted = true;
      const contents = open;
      open = null;
      if (contents && !contents.isDestroyed()) contents.close();
    },
  };
}
