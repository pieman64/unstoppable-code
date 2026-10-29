// Integration-style coverage for the worktree attachment import handler,
// using real fs under a temp CANOPY_DATA_DIR. Exists primarily to prove the
// Home composer's pre-worktree draft staging id ('home-draft', see
// HOME_DRAFT_WORKTREE_ID in the renderer's homeComposerStore) passes the
// main process's validateId gate and results in real staged files — the
// original underscore sentinel ('__home_draft__') was rejected at the IPC
// boundary before anything was written.

const showOpenDialogMock = jest.fn(() =>
  Promise.resolve({ canceled: true, filePaths: [] }),
);
const fromWebContentsMock = jest.fn<unknown, [unknown]>();
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]): unknown =>
      showOpenDialogMock(...args),
  },
  BrowserWindow: {
    fromWebContents: (contents: unknown): unknown =>
      fromWebContentsMock(contents),
  },
}));

const registeredHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type WorktreeImportAttachmentsRequest,
  type WorktreeImportAttachmentsResponse,
} from '@canopy/desktop-shared/types';
import { registerWorktreeAttachmentHandlers } from '../ipc/worktree-attachments';

// Keep in sync with HOME_DRAFT_WORKTREE_ID in
// apps/desktop-app/src/renderer/src/stores/homeComposerStore.ts (main tests
// do not import renderer modules).
const HOME_DRAFT_WORKTREE_ID = 'home-draft';

type ImportHandler = (
  event: unknown,
  request: WorktreeImportAttachmentsRequest,
) => Promise<WorktreeImportAttachmentsResponse>;

function getImportHandler(): ImportHandler {
  const handler = registeredHandlers.get(
    IPC_CHANNELS.worktreeImportAttachments,
  );
  if (typeof handler !== 'function') {
    throw new Error('worktreeImportAttachments handler was not registered');
  }
  return handler;
}

describe('worktree attachment import handler', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';
  let tempSourceDir = '';

  beforeEach(() => {
    registeredHandlers.clear();
    showOpenDialogMock.mockClear();
    fromWebContentsMock.mockReset();
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-attachments-data-'));
    tempSourceDir = mkdtempSync(join(tmpdir(), 'canopy-attachments-src-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
    registerWorktreeAttachmentHandlers();
  });

  afterEach(() => {
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    rmSync(tempSourceDir, { recursive: true, force: true });
  });

  it('stages files under the home-draft sentinel worktree id for pre-worktree targets', async () => {
    const sourcePath = join(tempSourceDir, 'notes.txt');
    writeFileSync(sourcePath, 'draft attachment body');

    const result = await getImportHandler()(undefined, {
      projectId: 'proj-1',
      worktreeId: HOME_DRAFT_WORKTREE_ID,
      filePaths: [sourcePath],
    });

    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0];
    expect(attachment.filename).toBe('notes.txt');
    // The staged copy is a real file inside the lazily-created
    // workspaces/{projectId}/attachments/home-draft/ directory.
    expect(existsSync(attachment.absolutePath)).toBe(true);
    expect(attachment.absolutePath).toBe(
      join(
        tempDataDir,
        'workspaces',
        'proj-1',
        'attachments',
        HOME_DRAFT_WORKTREE_ID,
        'notes.txt',
      ),
    );
    expect(attachment.sizeBytes).toBeGreaterThan(0);
  });

  // CAN-2706: an unparented open panel floats free of the app instead of
  // being presented as a window-modal sheet centered on it.
  it('presents the open panel over the window that requested it', async () => {
    const senderWindow = { isDestroyed: (): boolean => false };
    fromWebContentsMock.mockReturnValue(senderWindow);
    const sender = { id: 7 };

    await getImportHandler()(
      { sender },
      {
        projectId: 'proj-1',
        worktreeId: HOME_DRAFT_WORKTREE_ID,
        filePaths: [],
      },
    );

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender);
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      senderWindow,
      expect.objectContaining({
        title: 'Import attachments',
        properties: ['openFile', 'multiSelections'],
      }),
    );
  });

  it('falls back to an unparented open panel when the sender window is gone', async () => {
    fromWebContentsMock.mockReturnValue(null);

    await getImportHandler()(
      { sender: { id: 7 } },
      {
        projectId: 'proj-1',
        worktreeId: HOME_DRAFT_WORKTREE_ID,
        filePaths: [],
      },
    );

    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Import attachments' }),
    );
  });

  it('rejects the legacy underscore sentinel at the validateId gate', async () => {
    const sourcePath = join(tempSourceDir, 'notes.txt');
    writeFileSync(sourcePath, 'draft attachment body');

    await expect(
      getImportHandler()(undefined, {
        projectId: 'proj-1',
        worktreeId: '__home_draft__',
        filePaths: [sourcePath],
      }),
    ).rejects.toThrow('Invalid worktreeId');
    // Nothing was staged: the attachments tree for the project was never
    // created.
    expect(
      existsSync(join(tempDataDir, 'workspaces', 'proj-1', 'attachments')),
    ).toBe(false);
  });
});
