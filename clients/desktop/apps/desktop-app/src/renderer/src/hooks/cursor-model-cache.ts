import {
  initCursorModels,
  getCursorModelEntries,
  type CanopyApi,
  type CursorConnectionApi,
  type CursorModelEntry,
} from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

interface CursorModelSnapshot {
  models: CursorModelEntry[];
  message: string | undefined;
  generation: number;
}

export const EMPTY_CURSOR_MODELS: CursorModelSnapshot = {
  models: [
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Cursor default' },
  ],
  message: undefined,
  generation: 0,
};

/** One last-good catalog per renderer/connection, retained between picker mounts. */
class CursorModelCache {
  private snapshot = EMPTY_CURSOR_MODELS;
  private readonly listeners = new Set<() => void>();
  private pending: object | undefined;
  private watching = false;
  private blocked = false;
  private connecting = false;
  private enabled: boolean | undefined;
  private preferencesRevision = 0;

  constructor(
    private readonly api: CanopyApi,
    private readonly connection: CursorConnectionApi,
  ) {
    this.hydrate(getCursorModelEntries());
  }

  hydrate = (entries: CursorModelEntry[]): void => {
    if (this.blocked && entries.length > 0) return;
    const models = [
      ...EMPTY_CURSOR_MODELS.models,
      ...entries
        .filter((entry) => entry.id !== 'cursor-default')
        .map((entry) => ({ ...entry })),
    ];
    if (
      JSON.stringify(models) === JSON.stringify(this.snapshot.models) &&
      this.snapshot.message === undefined
    )
      return;
    this.publish({ ...this.snapshot, models, message: undefined });
  };

  getSnapshot = (): CursorModelSnapshot => this.snapshot;

  private publish(snapshot: CursorModelSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  private invalidate(blocked: boolean): void {
    this.blocked = blocked;
    this.pending = undefined;
    initCursorModels([]);
    this.publish({
      ...EMPTY_CURSOR_MODELS,
      generation: this.snapshot.generation + 1,
    });
  }

  private preferencesChanged(enabled: boolean): void {
    if (this.enabled === enabled) return;
    const previous = this.enabled;
    this.enabled = enabled;
    if (!enabled || previous !== undefined)
      this.invalidate(!enabled || this.connecting);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.watching) {
      this.watching = true;
      // Keep these bounded, renderer-lifetime listeners while no picker is mounted:
      // a disconnect in Settings must invalidate the next picker's snapshot too.
      const offProgress = this.connection.onProgress((status) => {
        ++this.preferencesRevision;
        this.connecting =
          status.phase !== 'connected' && status.phase !== 'idle';
        this.enabled = status.enabled;
        this.invalidate(
          this.connecting ||
            !status.enabled ||
            !status.installed ||
            !status.supported,
        );
      });
      const offLocal = subscribePreferencesUpdated((preferences) => {
        ++this.preferencesRevision;
        this.preferencesChanged(Boolean(preferences.cursorEnabled));
      });
      const offHost = this.api.onPreferencesChanged(() => {
        const revision = ++this.preferencesRevision;
        void this.api
          .loadPreferences()
          .then((preferences) => {
            if (revision === this.preferencesRevision)
              this.preferencesChanged(Boolean(preferences.cursorEnabled));
          })
          .catch(() => {
            // Availability owns preference-read errors. Preserve the last good catalog.
          });
      });
      window.addEventListener(
        'pagehide',
        () => {
          ++this.preferencesRevision;
          offProgress();
          offLocal();
          offHost();
          this.invalidate(true);
        },
        { once: true },
      );
    }
    return (): void => {
      this.listeners.delete(listener);
    };
  };

  refresh = (): void => {
    if (this.pending || this.blocked) return;
    const operation = {};
    this.pending = operation;
    // Only a first load says so: a refresh behind listed models stays quiet,
    // since those models can already be picked.
    const listed = this.snapshot.models.some(
      (entry) => entry.id !== 'cursor-default',
    );
    if (!listed) {
      this.publish({ ...this.snapshot, message: 'Loading Cursor models…' });
    }
    // Main bounds discovery to 45 seconds and drains it on connection changes.
    // Closing a picker only unsubscribes its view; completion still warms the cache.
    void this.connection
      .listModels()
      .then((entries) => {
        if (this.pending !== operation) return;
        initCursorModels(entries);
        this.publish({
          ...this.snapshot,
          models: [
            ...EMPTY_CURSOR_MODELS.models,
            ...entries.filter((entry) => entry.id !== 'cursor-default'),
          ],
          message: entries.length
            ? undefined
            : 'Reconnect Cursor in Settings to load models.',
        });
      })
      .catch(() => {
        if (this.pending !== operation) return;
        this.publish({
          ...this.snapshot,
          message:
            'Could not load Cursor models. Reopen this menu to try again.',
        });
      })
      .finally(() => {
        if (this.pending === operation) this.pending = undefined;
      });
  };
}

// No disk snapshot: the connection contract does not identify the signed-in
// account. A renderer reload hydrates main's last successful discovery.
const caches = new WeakMap<CursorConnectionApi, CursorModelCache>();
export function getCursorModelCache(
  api: CanopyApi,
): CursorModelCache | undefined {
  const connection = api?.cursorConnection;
  if (!connection?.listModels) return undefined;
  let cache = caches.get(connection);
  if (!cache) {
    cache = new CursorModelCache(api, connection);
    caches.set(connection, cache);
  }
  return cache;
}

/** Bootstrap and host broadcasts share the same catalog as mounted pickers. */
export function hydrateCursorModelCache(
  api: CanopyApi,
  models: CursorModelEntry[],
): void {
  getCursorModelCache(api)?.hydrate(models);
}
