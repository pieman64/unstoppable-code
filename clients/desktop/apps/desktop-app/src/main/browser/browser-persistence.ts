import { constants, readFileSync } from 'node:fs';
import {
  copyFile,
  stat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type BrowserLoadStatus,
  type BrowserSessionSnapshot,
  type BrowserThemeMode,
  type LoadWorktreeBrowserStateResponse,
  type PersistedWorktreeBrowserStateFile,
  type SaveWorktreeBrowserStateRequest,
} from '@canopy/desktop-shared/types';
import { getWorktreeBrowserStateFilePath } from '../lib/paths';
import {
  isBrowserProfileBinding,
  isBrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import { withArchivedWorkspaceOperationLock } from '../lib/archived-containers';
import { touchWorkspaceTargetWithoutOperationLock } from '../lib/workspace-activity';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';
import { isMcpOAuthBrowserScope } from '@canopy/execution-engine/types/browser';

const CURRENT_BROWSER_STATE_VERSION = 2;
const SAFE_BROWSER_STATE_ID = /^[a-z0-9][a-z0-9-]*$/;
let atomicWriteCounter = 0;

interface LegacyBrowserGroup {
  id: string;
  browserIds: string[];
  focusedBrowserId: string | null;
}

interface LegacyBrowserStateFile {
  version: 1;
  browsers: unknown[];
  groups: LegacyBrowserGroup[];
  activeGroupId: string | null;
}

export class BrowserStateHydrationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    void cause;
    this.name = 'BrowserStateHydrationError';
  }
}

export type BrowserStateCommit = (write: () => Promise<void>) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_BROWSER_STATE_ID.test(value);
}

function isLoadStatus(value: unknown): value is BrowserLoadStatus {
  return (
    value === 'idle' ||
    value === 'loading' ||
    value === 'ready' ||
    value === 'failed'
  );
}

function isThemeMode(value: unknown): value is BrowserThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * `system` is stored as `themeMode: 'light'` plus this flag. Builds that
 * predate `system` accept only `light` or `dark` and drop the whole saved
 * browser state for any other value (or for a missing one), so the stored
 * mode stays one they read; they open the page Light and drop the flag on
 * their next save.
 */
const THEME_FOLLOWS_APP_KEY = 'themeFollowsApp';

function readThemeMode(record: Record<string, unknown>): BrowserThemeMode {
  if (record[THEME_FOLLOWS_APP_KEY] === true) return 'system';
  return isThemeMode(record.themeMode) ? record.themeMode : 'light';
}

function toPersistedSnapshot(
  snapshot: BrowserSessionSnapshot,
): Record<string, unknown> {
  if (snapshot.themeMode !== 'system') return { ...snapshot };
  return {
    ...snapshot,
    themeMode: 'light',
    [THEME_FOLLOWS_APP_KEY]: true,
  };
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function readBrowserSnapshot(
  value: unknown,
  projectId: string,
  worktreeId: string,
): BrowserSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyId(value.id) ||
    value.projectId !== projectId ||
    value.worktreeId !== worktreeId ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    !isLoadStatus(value.status) ||
    typeof value.canGoBack !== 'boolean' ||
    typeof value.canGoForward !== 'boolean' ||
    typeof value.loading !== 'boolean' ||
    !isThemeMode(value.themeMode) ||
    typeof value.pickMode !== 'boolean' ||
    typeof value.recording !== 'boolean'
  ) {
    return null;
  }
  const faviconUrl = readOptionalString(value, 'faviconUrl');
  const lastError = readOptionalString(value, 'lastError');
  if (faviconUrl === null || lastError === null) return null;
  if (value.profile !== undefined && !isBrowserProfileBinding(value.profile))
    return null;
  if (value.taskScope !== undefined && !isBrowserTaskScope(value.taskScope))
    return null;
  return {
    id: value.id,
    projectId,
    worktreeId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    url: value.url,
    title: value.title,
    ...(faviconUrl !== undefined ? { faviconUrl } : {}),
    status: value.status,
    canGoBack: value.canGoBack,
    canGoForward: value.canGoForward,
    loading: value.loading,
    themeMode: readThemeMode(value),
    pickMode: value.pickMode,
    recording: value.recording,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(isBrowserProfileBinding(value.profile)
      ? { profile: value.profile }
      : {}),
    ...(isBrowserTaskScope(value.taskScope)
      ? { taskScope: value.taskScope }
      : {}),
  };
}

function readLegacyState(value: unknown): LegacyBrowserStateFile {
  if (!isRecord(value) || value.version !== 1) {
    throw new BrowserStateHydrationError(
      'Browser state is not a supported version-1 file.',
    );
  }
  if (!Array.isArray(value.browsers) || !Array.isArray(value.groups)) {
    throw new BrowserStateHydrationError(
      'Browser state has an invalid version-1 structure.',
    );
  }
  if (
    value.activeGroupId !== null &&
    value.activeGroupId !== undefined &&
    !isNonEmptyId(value.activeGroupId)
  ) {
    throw new BrowserStateHydrationError(
      'Browser state has an invalid active group.',
    );
  }
  const groups = value.groups.map((group, index): LegacyBrowserGroup => {
    if (
      !isRecord(group) ||
      !isNonEmptyId(group.id) ||
      !Array.isArray(group.browserIds)
    ) {
      throw new BrowserStateHydrationError(
        `Browser state has an invalid group at index ${index}.`,
      );
    }
    const focusedBrowserId = isNonEmptyId(group.focusedBrowserId)
      ? group.focusedBrowserId
      : null;
    return {
      id: group.id,
      browserIds: group.browserIds.filter(isNonEmptyId),
      focusedBrowserId,
    };
  });
  return {
    version: 1,
    browsers: value.browsers,
    groups,
    activeGroupId: isNonEmptyId(value.activeGroupId)
      ? value.activeGroupId
      : null,
  };
}

function normalizeLegacyState(
  value: unknown,
  projectId: string,
  worktreeId: string,
): PersistedWorktreeBrowserStateFile {
  const legacy = readLegacyState(value);
  const snapshotsById = new Map<string, BrowserSessionSnapshot>();
  for (const value of legacy.browsers) {
    const snapshot = readBrowserSnapshot(value, projectId, worktreeId);
    if (snapshot && !snapshotsById.has(snapshot.id)) {
      snapshotsById.set(snapshot.id, snapshot);
    }
  }

  const browserOrder: string[] = [];
  const seen = new Set<string>();
  for (const group of legacy.groups) {
    for (const browserId of group.browserIds) {
      if (snapshotsById.has(browserId) && !seen.has(browserId)) {
        seen.add(browserId);
        browserOrder.push(browserId);
      }
    }
  }
  for (const browserId of Array.from(snapshotsById.keys())) {
    if (!seen.has(browserId)) {
      seen.add(browserId);
      browserOrder.push(browserId);
    }
  }

  const activeGroup = legacy.groups.find(
    (group) => group.id === legacy.activeGroupId,
  );
  const activeBrowserId =
    activeGroup?.focusedBrowserId &&
    snapshotsById.has(activeGroup.focusedBrowserId)
      ? activeGroup.focusedBrowserId
      : (browserOrder[0] ?? null);
  const browsers = browserOrder.map((browserId) => {
    const snapshot = snapshotsById.get(browserId);
    if (!snapshot) {
      throw new BrowserStateHydrationError(
        `Browser state lost snapshot ${browserId} during migration.`,
      );
    }
    return snapshot;
  });

  return {
    version: CURRENT_BROWSER_STATE_VERSION,
    browserOrder,
    activeBrowserId,
    browsers,
  };
}

function readCurrentState(
  value: unknown,
  projectId: string,
  worktreeId: string,
): PersistedWorktreeBrowserStateFile {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== CURRENT_BROWSER_STATE_VERSION) ||
    !Array.isArray(value.browserOrder) ||
    !Array.isArray(value.browsers) ||
    (value.activeBrowserId !== null && !isNonEmptyId(value.activeBrowserId))
  ) {
    throw new BrowserStateHydrationError(
      'Browser state has an invalid version-1 structure.',
    );
  }
  if (!value.browserOrder.every(isNonEmptyId)) {
    throw new BrowserStateHydrationError(
      'Browser state has an invalid browser order.',
    );
  }
  const snapshots = value.browsers.map((entry, index) => {
    const snapshot = readBrowserSnapshot(entry, projectId, worktreeId);
    if (!snapshot) {
      throw new BrowserStateHydrationError(
        `Browser state has an invalid or foreign snapshot at index ${index}.`,
      );
    }
    return snapshot;
  });
  const snapshotIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshotIds.has(snapshot.id)) {
      throw new BrowserStateHydrationError(
        `Browser state contains duplicate snapshot ${snapshot.id}.`,
      );
    }
    snapshotIds.add(snapshot.id);
  }
  const orderIds = new Set<string>();
  for (const browserId of value.browserOrder) {
    if (orderIds.has(browserId) || !snapshotIds.has(browserId)) {
      throw new BrowserStateHydrationError(
        `Browser state contains an invalid order entry ${browserId}.`,
      );
    }
    orderIds.add(browserId);
  }
  if (orderIds.size !== snapshotIds.size) {
    throw new BrowserStateHydrationError(
      'Browser state order does not include every snapshot.',
    );
  }
  return {
    version: CURRENT_BROWSER_STATE_VERSION,
    browserOrder: [...value.browserOrder],
    activeBrowserId: value.activeBrowserId,
    browsers: snapshots,
  };
}

function serializeState(state: PersistedWorktreeBrowserStateFile): string {
  const persisted = {
    ...state,
    browsers: state.browsers.map(toPersistedSnapshot),
  };
  return `${JSON.stringify(persisted, null, 2)}\n`;
}

async function writeStateAtomicallyAsync(
  filePath: string,
  state: PersistedWorktreeBrowserStateFile,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  atomicWriteCounter =
    atomicWriteCounter >= Number.MAX_SAFE_INTEGER ? 1 : atomicWriteCounter + 1;
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${atomicWriteCounter}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializeState(state), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function fallbackState(error: string): LoadWorktreeBrowserStateResponse {
  return {
    status: 'fallback',
    state: {
      version: CURRENT_BROWSER_STATE_VERSION,
      browserOrder: [],
      activeBrowserId: null,
      browsers: [],
    },
    error,
  };
}

interface ReadWorktreeBrowserStateResult {
  response: LoadWorktreeBrowserStateResponse;
  migration?: {
    filePath: string;
    state: PersistedWorktreeBrowserStateFile;
  };
}

function readWorktreeBrowserState(
  projectId: string,
  worktreeId: string,
): ReadWorktreeBrowserStateResult {
  const filePath = getWorktreeBrowserStateFilePath(projectId, worktreeId);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      response:
        isRecord(error) && error.code === 'ENOENT'
          ? { status: 'missing', state: null }
          : fallbackState('Browser state could not be read.'),
    };
  }

  return parseWorktreeBrowserState(raw, filePath, projectId, worktreeId);
}

/** Bounded async metadata reads for cross-task profile previews; never opens Sessions. */
export async function loadWorktreeBrowserStateAsync(
  projectId: string,
  worktreeId: string,
): Promise<LoadWorktreeBrowserStateResponse> {
  const filePath = getWorktreeBrowserStateFilePath(projectId, worktreeId);
  try {
    if ((await stat(filePath)).size > 16 * 1024 * 1024)
      return fallbackState('Browser state exceeds the metadata size limit.');
    const raw = await readFile(filePath, 'utf8');
    return parseWorktreeBrowserState(raw, filePath, projectId, worktreeId)
      .response;
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT'
      ? { status: 'missing', state: null }
      : fallbackState('Browser state could not be read.');
  }
}

function parseWorktreeBrowserState(
  raw: string,
  filePath: string,
  projectId: string,
  worktreeId: string,
): ReadWorktreeBrowserStateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      response: fallbackState('Browser state contains invalid JSON.'),
    };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') {
    return {
      response: fallbackState('Browser state has no supported version.'),
    };
  }
  if (parsed.version > CURRENT_BROWSER_STATE_VERSION) {
    return {
      response: fallbackState(
        `Browser state version ${parsed.version} is newer than supported version ${CURRENT_BROWSER_STATE_VERSION}.`,
      ),
    };
  }
  if (
    parsed.version !== 1 &&
    parsed.version !== CURRENT_BROWSER_STATE_VERSION
  ) {
    return {
      response: fallbackState(
        `Browser state version ${parsed.version} is not supported.`,
      ),
    };
  }
  if ('browserOrder' in parsed || 'activeBrowserId' in parsed) {
    try {
      const state = readCurrentState(parsed, projectId, worktreeId);
      return {
        response: {
          status: 'loaded',
          state,
        },
        ...(parsed.version === 1 ? { migration: { filePath, state } } : {}),
      };
    } catch (error) {
      if (error instanceof BrowserStateHydrationError) {
        return { response: fallbackState(error.message) };
      }
      throw error;
    }
  }
  let state: PersistedWorktreeBrowserStateFile;
  try {
    state = normalizeLegacyState(parsed, projectId, worktreeId);
  } catch (error) {
    if (error instanceof BrowserStateHydrationError) {
      return { response: fallbackState(error.message) };
    }
    throw error;
  }
  return {
    response: { status: 'loaded', state },
    migration: { filePath, state },
  };
}

export function loadWorktreeBrowserState(
  projectId: string,
  worktreeId: string,
): LoadWorktreeBrowserStateResponse {
  return readWorktreeBrowserState(projectId, worktreeId).response;
}

export async function loadAndMigrateWorktreeBrowserState(
  projectId: string,
  worktreeId: string,
): Promise<LoadWorktreeBrowserStateResponse> {
  const result = readWorktreeBrowserState(projectId, worktreeId);
  if (result.migration) {
    try {
      await copyFile(
        result.migration.filePath,
        `${result.migration.filePath}.v1.backup`,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    }
    await writeStateAtomicallyAsync(
      result.migration.filePath,
      result.migration.state,
    );
  }
  return result.response;
}

export async function saveWorktreeBrowserState(
  request: SaveWorktreeBrowserStateRequest,
  commitBinding?: BrowserStateCommit,
  signal?: AbortSignal,
): Promise<void> {
  // Authorization URLs contain transient state. Sign-in views have no
  // workspace activity and must not be saved or resurrected on restart.
  if (isMcpOAuthBrowserScope(request.projectId, request.worktreeId)) return;
  const filePath = getWorktreeBrowserStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  const state = readCurrentState(
    request.state,
    request.projectId,
    request.worktreeId,
  );
  await withWorkspaceTargetRuntimeStartReservation(
    request.projectId,
    request.worktreeId,
    () =>
      withArchivedWorkspaceOperationLock(
        request.projectId,
        async () => {
          const write = async (): Promise<void> => {
            signal?.throwIfAborted();
            await touchWorkspaceTargetWithoutOperationLock(
              request.projectId,
              request.worktreeId,
            );
            await writeStateAtomicallyAsync(filePath, state);
          };
          // Workspace deletion/restore also accesses the profile repository while
          // holding this lock. Acquire binding authority only after the workspace
          // lock, and retain it through the durable write (and switch decision).
          if (commitBinding) await commitBinding(write);
          else await write();
        },
        signal,
      ),
  );
}
