import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  PortalDiffPayload,
  PortalDiffReadPayload,
  PortalFilePreview,
  PortalFileReadPayload,
} from '@canopy/protocol/portal';
import { useCanopyClientStore } from '../CanopyClientProvider';
import type { ClientStore } from '../client-store-lifecycle';

/** Neutral view mode; the concrete renderer maps preview/table to the file kind. */
export type FileViewMode = 'raw' | 'preview' | 'table';

/** Async lifecycle of a file or diff read/save. */
export type FileViewerStatus = 'idle' | 'loading' | 'saving' | 'error';

/** One open file, keyed by {@link fileViewerKey}. */
export interface FileViewerSession {
  readonly key: string;
  /** The read request that identifies this file (routing + relative path). */
  readonly request: PortalFileReadPayload;
  /** Last server-confirmed content/version; `null` until the first read lands. */
  readonly preview: PortalFilePreview | null;
  /** Current (possibly edited) buffer contents. */
  readonly content: string;
  /** True when `content` differs from the last confirmed `preview.content`. */
  readonly dirty: boolean;
  readonly viewMode: FileViewMode;
  readonly status: FileViewerStatus;
  readonly error: string | null;
  /** Capability resolved for this session's project at open time. */
  readonly canEdit: boolean;
}

/** One open diff, keyed by {@link diffViewerKey}. */
export interface DiffViewerSession {
  readonly key: string;
  readonly request: PortalDiffReadPayload;
  readonly diff: PortalDiffPayload | null;
  readonly status: FileViewerStatus;
  readonly error: string | null;
}

export interface FileViewerState {
  readonly files: Readonly<Record<string, FileViewerSession>>;
  readonly diffs: Readonly<Record<string, DiffViewerSession>>;
  /** Key of the most recently opened file, or `null`. */
  readonly activeFileKey: string | null;
  /** Key of the most recently opened diff, or `null`. */
  readonly activeDiffKey: string | null;
  /**
   * Whether this host can write files. Derived once from
   * `capabilities.fileSystemAccess === 'read-write'`; web relays report `read`.
   */
  readonly canEdit: boolean;

  /**
   * Read a file into a session and mark it active; resolves to its key.
   * Actions are declared as function-typed properties (not method syntax) so
   * hosts can select them off a snapshot (`useStore((s) => s.openFile)`)
   * without tripping `@typescript-eslint/unbound-method` — none of them use
   * `this`.
   */
  openFile: (request: PortalFileReadPayload) => Promise<string>;
  /** Update the editor buffer for a file (recomputes `dirty`). */
  updateContent: (key: string, content: string) => void;
  /** Persist the buffer. Rejects locally (no command) when `canEdit` is false. */
  saveFile: (key: string) => Promise<boolean>;
  /** Revert the buffer to the last confirmed `preview.content`. */
  discardEdits: (key: string) => void;
  /** Switch a file's view mode. */
  setViewMode: (key: string, viewMode: FileViewMode) => void;
  /** Drop a file session. */
  closeFile: (key: string) => void;
  /** Read a diff into a session and mark it active; resolves to its key. */
  openDiff: (request: PortalDiffReadPayload) => Promise<string>;
  /** Drop a diff session. */
  closeDiff: (key: string) => void;
}

/**
 * Stable session key for a file read request (multi-repo safe).
 *
 * `fileRootLocalId` takes precedence over `repoId` to mirror the protocol's own
 * resolution rule (`PortalFileReadPayload`: "setting both is permitted but
 * `fileRootLocalId` wins"). Keying on the field the server actually resolves
 * against prevents two distinct files from collapsing onto one session.
 */
export function fileViewerKey(request: PortalFileReadPayload): string {
  const root = request.fileRootLocalId ?? request.repoId ?? '';
  return `${request.projectId}:${request.worktreeId}:${root}:${request.relativePath}`;
}

/** Stable session key for a diff read request. */
export function diffViewerKey(request: PortalDiffReadPayload): string {
  return `${request.workspaceId}:${request.worktreeId}:${request.repoId ?? ''}:${request.path ?? ''}:${request.source ?? 'combined'}`;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Create a file/diff viewer store bound to a single {@link CanopyClient}.
 * Reads go through `client.query('file.read' | 'diff.read')`; saves through
 * `client.command('file.save')`, gated on the host's `fileSystemAccess`
 * capability. Wrapped by {@link createClientStore} for per-client memoization.
 */
export function createFileViewerStore(
  client: CanopyClient,
): UseBoundStore<StoreApi<FileViewerState>> {
  const canEdit = client.capabilities.fileSystemAccess === 'read-write';

  return create<FileViewerState>((set, get) => {
    const patchFile = (
      key: string,
      patch: Partial<FileViewerSession>,
    ): void => {
      set((state) => {
        const prev = state.files[key];
        if (!prev) {
          return state;
        }
        return { files: { ...state.files, [key]: { ...prev, ...patch } } };
      });
    };

    // Monotonic per-key generation. `closeFile` bumps it so an in-flight
    // read/save that resolves after the session was closed (or closed and
    // reopened under the same key) cannot repopulate or patch the replacement.
    const generations = new Map<string, number>();
    const currentGeneration = (key: string): number =>
      generations.get(key) ?? 0;
    const invalidateGeneration = (key: string): void => {
      generations.set(key, currentGeneration(key) + 1);
    };

    // A re-read of an open session keeps the previous content editable, so an
    // edit or a save can land while it is in flight. Each read takes a token
    // and only the latest read for a key may settle the session. A save
    // advances the key's save epoch: a read that started before it must not
    // replace the saved buffer or baseline. An edit made during a read wins
    // while it is still unsaved when the read lands, and keeps the baseline it
    // was made against so a later save still detects a newer disk version.
    let readTokenCounter = 0;
    const latestReadTokens = new Map<string, number>();
    const saveEpochs = new Map<string, number>();
    const currentSaveEpoch = (key: string): number => saveEpochs.get(key) ?? 0;
    // Decides whether a landed read may apply its result, and settles the
    // session when it may not. A read superseded by a newer read touches
    // nothing: the newer read owns the loading sentinel. A read superseded by
    // a save or an unsaved edit releases only its own loading sentinel; a save
    // owns the status until it settles.
    const claimLandedRead = (
      key: string,
      readToken: number,
      saveEpoch: number,
    ): boolean => {
      if (latestReadTokens.get(key) !== readToken) {
        return false;
      }
      const current = get().files[key];
      if (currentSaveEpoch(key) === saveEpoch && current?.dirty !== true) {
        return true;
      }
      if (current?.status === 'loading') {
        patchFile(key, { status: 'idle' });
      }
      return false;
    };

    // Per-canonical-key in-flight save transactions so concurrent save entries
    // (Cmd/Ctrl+S spam, autosave racing an explicit Save, close-save) collapse
    // onto one physical `file.save`, and a later explicit save while one is in
    // flight issues at most one follow-up when newer content stays dirty.
    const inFlightSaves = new Map<
      string,
      { generation: number; promise: Promise<boolean> }
    >();

    return {
      files: {},
      diffs: {},
      activeFileKey: null,
      activeDiffKey: null,
      canEdit,

      async openFile(request): Promise<string> {
        const key = fileViewerKey(request);
        const existing = get().files[key];
        const sessionCapabilities =
          client.capabilitiesFor?.(request.projectId) ?? client.capabilities;
        const sessionCanEdit =
          sessionCapabilities.fileSystemAccess === 'read-write';
        // Re-opening a session with an in-flight read, unsaved edits, or an
        // in-flight save just focuses it. Re-reading would duplicate work,
        // clobber the user's buffer, or drop the 'saving' sentinel (and let the
        // save's post-resolve write win a race).
        if (
          existing &&
          (existing.dirty ||
            existing.status === 'loading' ||
            existing.status === 'saving')
        ) {
          patchFile(key, { canEdit: sessionCanEdit });
          set({ activeFileKey: key });
          return key;
        }
        const generation = currentGeneration(key);
        readTokenCounter += 1;
        const readToken = readTokenCounter;
        latestReadTokens.set(key, readToken);
        const saveEpoch = currentSaveEpoch(key);
        set((state) => {
          const prev = state.files[key];
          const session: FileViewerSession = prev
            ? {
                ...prev,
                status: 'loading',
                error: null,
                canEdit: sessionCanEdit,
              }
            : {
                key,
                request,
                preview: null,
                content: '',
                dirty: false,
                // Newly created sessions default to the rendered view; hosts
                // that persist a per-tab mode (desktop) pass a controlled
                // `viewMode` prop that overrides this, and FileViewer forces
                // raw for kinds with no preview and normalizes CSV to 'table'.
                viewMode: 'preview',
                status: 'loading',
                error: null,
                canEdit: sessionCanEdit,
              };
          return {
            files: { ...state.files, [key]: session },
            activeFileKey: key,
          };
        });
        try {
          const preview = await client.query('file.read', request);
          // A close (and possible reopen) during the read invalidates this
          // completion; do not clobber the reopened session with stale content.
          if (currentGeneration(key) !== generation) {
            return key;
          }
          // A newer read, a save, or an unsaved edit made during this read is
          // newer than what it read.
          if (!claimLandedRead(key, readToken, saveEpoch)) {
            return key;
          }
          patchFile(key, {
            preview,
            content: preview.content,
            dirty: false,
            status: 'idle',
            error: null,
          });
        } catch (error) {
          if (currentGeneration(key) !== generation) {
            return key;
          }
          if (!claimLandedRead(key, readToken, saveEpoch)) {
            return key;
          }
          patchFile(key, {
            status: 'error',
            error: errorMessage(error, 'Failed to read file.'),
          });
        }
        return key;
      },

      updateContent(key, content): void {
        const prev = get().files[key];
        if (!prev) {
          return;
        }
        // Clear a stale save error the moment the buffer actually changes so the
        // editor stops showing a previous failure against the new draft. An
        // active `saving` sentinel is preserved (a concurrent write continues).
        const contentChanged = content !== prev.content;
        const clearError = contentChanged && prev.status === 'error';
        patchFile(key, {
          content,
          dirty: content !== (prev.preview?.content ?? ''),
          ...(clearError ? { status: 'idle', error: null } : {}),
        });
      },

      async saveFile(key): Promise<boolean> {
        const session = get().files[key];
        if (!session) {
          return false;
        }
        // A clean session has nothing to persist; report success without a
        // command so no redundant write follows a just-completed save.
        if (!session.dirty) {
          return true;
        }
        if (!session.canEdit) {
          patchFile(key, {
            status: 'error',
            error: 'File editing is not available on this host.',
          });
          return false;
        }

        // Share one physical write across concurrent callers for this key. A
        // later caller awaits the active transaction and — only if newer content
        // is still dirty when it settles and the session was not closed —
        // initiates at most one follow-up save.
        const active = inFlightSaves.get(key);
        if (active) {
          return active.promise.then((ok) => {
            if (!ok) {
              return false;
            }
            const latest = get().files[key];
            if (
              latest &&
              latest.dirty &&
              currentGeneration(key) === active.generation
            ) {
              return get().saveFile(key);
            }
            return true;
          });
        }

        // Fail closed: an editable dirty session without a parseable confirmed
        // mtime must not issue an unversioned write, which could silently
        // overwrite an external edit. Retain the buffer and surface guidance.
        const parsedMtime = session.preview?.modifiedAt
          ? Date.parse(session.preview.modifiedAt)
          : Number.NaN;
        if (Number.isNaN(parsedMtime)) {
          patchFile(key, {
            status: 'error',
            error:
              'Unable to save because the file version is unavailable. Reopen the file and try again.',
          });
          return false;
        }
        const expectedModifiedAtMs = parsedMtime;
        const snapshotContent = session.content;
        const generation = currentGeneration(key);

        saveEpochs.set(key, currentSaveEpoch(key) + 1);
        patchFile(key, { status: 'saving', error: null });

        // Identity-tracked transaction so the `finally` can clear the map entry
        // only when it is still this same in-flight save (a follow-up save under
        // the same key installs a new transaction).
        const transaction: { generation: number; promise: Promise<boolean> } = {
          generation,
          promise: Promise.resolve(false),
        };
        transaction.promise = (async (): Promise<boolean> => {
          try {
            const preview = await client.command('file.save', {
              ...session.request,
              content: snapshotContent,
              expectedVersion: session.preview?.version,
              expectedModifiedAtMs,
            });
            // The session may have been closed (and possibly reopened) while the
            // write was in flight; a stale completion must not patch the
            // replacement session.
            if (currentGeneration(key) !== generation) {
              return true;
            }
            const current = get().files[key];
            if (!current) {
              return true;
            }
            // Refresh the server baseline (version/mtime). If the user kept
            // typing during the round-trip, keep their newer buffer and stay
            // dirty rather than overwriting it with the just-saved content.
            if (current.content !== snapshotContent) {
              patchFile(key, {
                preview,
                dirty: current.content !== preview.content,
                status: 'idle',
                error: null,
              });
            } else {
              patchFile(key, {
                preview,
                content: preview.content,
                dirty: false,
                status: 'idle',
                error: null,
              });
            }
            return true;
          } catch (error) {
            // Leave content, preview, and mtime unchanged; keep dirty so a
            // retry re-sends the same confirmed mtime and a conflict stays
            // fail-closed until a fresh read/save advances it.
            if (currentGeneration(key) === generation) {
              patchFile(key, {
                status: 'error',
                error: errorMessage(error, 'Failed to save file.'),
                dirty: true,
              });
            }
            return false;
          } finally {
            if (inFlightSaves.get(key) === transaction) {
              inFlightSaves.delete(key);
            }
          }
        })();

        inFlightSaves.set(key, transaction);
        return transaction.promise;
      },

      discardEdits(key): void {
        const prev = get().files[key];
        if (!prev) {
          return;
        }
        patchFile(key, {
          content: prev.preview?.content ?? '',
          dirty: false,
          status: 'idle',
          error: null,
        });
      },

      setViewMode(key, viewMode): void {
        patchFile(key, { viewMode });
      },

      closeFile(key): void {
        // Invalidate any in-flight read/save so a late completion cannot
        // repopulate or patch a session reopened under the same key, and drop
        // the dedup entry so a reopened session starts a fresh transaction.
        invalidateGeneration(key);
        inFlightSaves.delete(key);
        latestReadTokens.delete(key);
        saveEpochs.delete(key);
        set((state) => {
          if (!(key in state.files)) {
            return state;
          }
          const files = { ...state.files };
          delete files[key];
          return {
            files,
            activeFileKey:
              state.activeFileKey === key ? null : state.activeFileKey,
          };
        });
      },

      async openDiff(request): Promise<string> {
        const key = diffViewerKey(request);
        set((state) => ({
          diffs: {
            ...state.diffs,
            [key]: {
              key,
              request,
              diff: state.diffs[key]?.diff ?? null,
              status: 'loading',
              error: null,
            },
          },
          activeDiffKey: key,
        }));
        try {
          const diff = await client.query('diff.read', request);
          set((state) => {
            const prev = state.diffs[key];
            if (!prev) {
              return state;
            }
            return {
              diffs: {
                ...state.diffs,
                [key]: { ...prev, diff, status: 'idle', error: null },
              },
            };
          });
        } catch (error) {
          set((state) => {
            const prev = state.diffs[key];
            if (!prev) {
              return state;
            }
            return {
              diffs: {
                ...state.diffs,
                [key]: {
                  ...prev,
                  status: 'error',
                  error: errorMessage(error, 'Failed to read diff.'),
                },
              },
            };
          });
        }
        return key;
      },

      closeDiff(key): void {
        set((state) => {
          if (!(key in state.diffs)) {
            return state;
          }
          const diffs = { ...state.diffs };
          delete diffs[key];
          return {
            diffs,
            activeDiffKey:
              state.activeDiffKey === key ? null : state.activeDiffKey,
          };
        });
      },
    };
  });
}

/**
 * Single private symbol backing BOTH file-viewer hooks so they always resolve
 * the same provider-scoped store instance. Registering under a second symbol
 * (or a second `createClientStore`/`useCanopyClientStore` call) would mint a
 * distinct store and split ownership of the file buffer — the exact failure
 * mode CAN-1426 exists to prevent.
 */
const fileViewerStoreKey = Symbol('file-viewer-store');

/**
 * Provider-bound imperative handle to the shared file/diff viewer store. The
 * desktop session controller attaches this exact instance so shortcuts,
 * autosave, and close guards operate on the same buffer the FileViewer edits.
 * Returns `ClientStore<FileViewerState>` (a `UseBoundStore<StoreApi<...>>`),
 * which satisfies the controller's `attachStore(store: StoreApi<...>)`.
 */
export function useFileViewerStoreApi(): ClientStore<FileViewerState> {
  return useCanopyClientStore<FileViewerState>(
    fileViewerStoreKey,
    createFileViewerStore,
  );
}

/**
 * Selector hook for the shared file/diff viewer store, bound to the ambient
 * {@link CanopyClient} from `CanopyClientProvider`. Derived from
 * {@link useFileViewerStoreApi} so the two hooks can never resolve different
 * store instances.
 */
export function useFileViewerStore<TSelected>(
  selector: (state: FileViewerState) => TSelected,
): TSelected {
  return useFileViewerStoreApi()(selector);
}
