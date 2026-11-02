import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import {
  isPanelLayoutModeFileV1,
  isWorkspaceLayoutMode,
  type PanelLayoutModeFileV1,
  type WorkspaceLayoutMode,
} from '../../types';
import { validateId } from './validation';

export const DEFAULT_WORKSPACE_LAYOUT_MODE: WorkspaceLayoutMode = 'advanced';
export const PANEL_LAYOUT_MODE_FILENAME = 'panel-layout-mode.json';

export interface PanelLayoutModeFileTarget {
  workspaceId: string;
  worktreeId: string;
  filePath: string;
}

let atomicWriteCounter = 0;
const mutationQueues = new Map<string, Promise<void>>();

function validateTarget(target: PanelLayoutModeFileTarget): void {
  validateId(target.workspaceId, 'workspaceId');
  validateId(target.worktreeId, 'worktreeId');
  if (
    !isAbsolute(target.filePath) ||
    basename(target.filePath) !== PANEL_LAYOUT_MODE_FILENAME ||
    basename(dirname(target.filePath)) !== target.worktreeId
  ) {
    throw new Error('Invalid panel layout mode file path');
  }
}

function validateMode(mode: unknown): asserts mode is WorkspaceLayoutMode {
  if (!isWorkspaceLayoutMode(mode)) {
    throw new Error(`Invalid project layout mode: ${String(mode)}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function createAtomicWriteTempPath(filePath: string): string {
  atomicWriteCounter =
    atomicWriteCounter >= Number.MAX_SAFE_INTEGER ? 1 : atomicWriteCounter + 1;
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${atomicWriteCounter}.tmp`,
  );
}

async function writeModeFileAtomically(
  filePath: string,
  mode: WorkspaceLayoutMode,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = createAtomicWriteTempPath(filePath);
  const existingMode = await stat(filePath)
    .then((fileStats) => fileStats.mode)
    .catch((error: unknown) => {
      if (isMissingFileError(error)) return undefined;
      throw error;
    });
  const file: PanelLayoutModeFileV1 = { version: 1, mode };
  let cleanupTemp = true;
  try {
    // eslint-disable-next-line admitted-writers/no-unadmitted-write -- a panel-layout-mode.json temp file; remove when this module stops reading preferences.
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: existingMode,
    });
    // eslint-disable-next-line admitted-writers/no-unadmitted-write -- commits panel-layout-mode.json; remove when this module stops reading preferences.
    await rename(tempPath, filePath);
    cleanupTemp = false;
  } finally {
    if (cleanupTemp) {
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- a panel-layout-mode.json temp file; remove when this module stops reading preferences.
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function withMutationLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  mutationQueues.set(filePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (mutationQueues.get(filePath) === queued) {
      mutationQueues.delete(filePath);
    }
  }
}

export async function readPanelLayoutModeFile(
  target: PanelLayoutModeFileTarget,
): Promise<WorkspaceLayoutMode | null> {
  validateTarget(target);
  try {
    const parsed: unknown = JSON.parse(await readFile(target.filePath, 'utf8'));
    return isPanelLayoutModeFileV1(parsed) ? parsed.mode : null;
  } catch {
    return null;
  }
}

export async function initializePanelLayoutModeFile(
  target: PanelLayoutModeFileTarget,
  mode: WorkspaceLayoutMode,
): Promise<WorkspaceLayoutMode> {
  validateTarget(target);
  validateMode(mode);
  return withMutationLock(target.filePath, async () => {
    const existing = await readPanelLayoutModeFile(target);
    if (existing !== null) return existing;
    await writeModeFileAtomically(target.filePath, mode);
    return mode;
  });
}

export async function savePanelLayoutModeFile(
  target: PanelLayoutModeFileTarget,
  mode: WorkspaceLayoutMode,
): Promise<void> {
  validateTarget(target);
  validateMode(mode);
  await withMutationLock(target.filePath, () =>
    writeModeFileAtomically(target.filePath, mode),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeWorkspaceDefaultLayoutMode(
  value: unknown,
): WorkspaceLayoutMode {
  return isWorkspaceLayoutMode(value) ? value : DEFAULT_WORKSPACE_LAYOUT_MODE;
}

export async function readWorkspaceDefaultLayoutMode(
  dataDir: string = getCanopyDataDir(),
): Promise<WorkspaceLayoutMode> {
  if (!isAbsolute(dataDir)) {
    throw new Error('Invalid preferences data directory: must be absolute');
  }
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(dataDir, 'preferences.json'), 'utf8'),
    );
    if (!isRecord(parsed)) return DEFAULT_WORKSPACE_LAYOUT_MODE;
    const preferences = isRecord(parsed.preferences)
      ? parsed.preferences
      : parsed;
    return normalizeWorkspaceDefaultLayoutMode(
      preferences.workspaceDefaultLayoutMode,
    );
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT_MODE;
  }
}
