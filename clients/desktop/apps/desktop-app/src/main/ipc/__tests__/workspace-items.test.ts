import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerWorkspaceItemHandlers } from '../workspace-items';
import {
  listNotesForProject,
  readNoteForProject,
  listPromptsForProject,
  readPromptForProject,
  listAttachmentsForProject,
} from '../../services/workspace-items-service';

const handlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../../services/workspace-items-service', () => ({
  listNotesForProject: jest.fn(),
  readNoteForProject: jest.fn(),
  listPromptsForProject: jest.fn(),
  readPromptForProject: jest.fn(),
  listAttachmentsForProject: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({}));
jest.mock('../../lib/agent-attachments', () => ({}));
jest.mock('../../lib/cowork-migration-map', () => ({}));
jest.mock('../../lib/main-process-logging', () => ({}));
jest.mock('../../lib/workspace-registry', () => ({}));
jest.mock('../../lib/standalone-workspace-files', () => ({}));
jest.mock('../../lib/workspace-items', () => ({}));
jest.mock('../../lib/path-safety', () => ({}));
jest.mock('../../lib/workspace-prompt-mentions', () => ({}));
jest.mock('../../lib/dialog-window', () => ({}));
jest.mock('../../shared-containers/file-scope-store', () => ({}));
jest.mock('../../shared-containers/publish/scheduler', () => ({}));

const item = {
  id: 'item-1',
  title: 'Title',
  absolutePath: '/local/item.md',
  createdAt: '2026-09-08',
  updatedAt: '2026-09-08',
};

describe('project items IPC read delegation', (): void => {
  beforeEach((): void => {
    jest.resetAllMocks();
    handlers.clear();
    registerWorkspaceItemHandlers();
  });

  it('delegates workspaceNotesList and preserves the desktop result', async (): Promise<void> => {
    const result = [item];
    jest.mocked(listNotesForProject).mockResolvedValue(result);
    const handler = handlers.get(IPC_CHANNELS.workspaceNotesList);
    if (!handler) throw new Error('Missing read handler');
    // The worktree id reaches worktree-scoped read adapters (shared-container
    // viewer); ordinary workspace scopes ignore it.
    await expect(
      handler(undefined, { projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toBe(result);
    expect(listNotesForProject).toHaveBeenCalledWith(...['project-1', 'wt-1']);
  });

  it('delegates workspaceNotesRead and preserves the desktop result', async (): Promise<void> => {
    const result = { meta: item, content: 'Note' };
    jest.mocked(readNoteForProject).mockResolvedValue(result);
    const handler = handlers.get(IPC_CHANNELS.workspaceNotesRead);
    if (!handler) throw new Error('Missing read handler');
    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        noteId: 'item-1',
      }),
    ).resolves.toBe(result);
    expect(readNoteForProject).toHaveBeenCalledWith(
      ...['project-1', 'item-1', 'wt-1'],
    );
  });

  it('delegates workspacePromptsList and preserves the desktop result', async (): Promise<void> => {
    const result = [item];
    jest.mocked(listPromptsForProject).mockResolvedValue(result);
    const handler = handlers.get(IPC_CHANNELS.workspacePromptsList);
    if (!handler) throw new Error('Missing read handler');
    await expect(
      handler(undefined, { projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toBe(result);
    expect(listPromptsForProject).toHaveBeenCalledWith(
      ...['project-1', 'wt-1'],
    );
  });

  it('delegates workspacePromptsRead and preserves the desktop result', async (): Promise<void> => {
    const result = { meta: item, content: 'Prompt' };
    jest.mocked(readPromptForProject).mockResolvedValue(result);
    const handler = handlers.get(IPC_CHANNELS.workspacePromptsRead);
    if (!handler) throw new Error('Missing read handler');
    await expect(
      handler(undefined, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        promptId: 'item-1',
      }),
    ).resolves.toBe(result);
    expect(readPromptForProject).toHaveBeenCalledWith(
      ...['project-1', 'item-1', 'wt-1'],
    );
  });

  it('delegates workspaceAttachmentsList and preserves the desktop result', async (): Promise<void> => {
    const result = [
      {
        filename: 'file.png',
        absolutePath: '/local/file.png',
        sizeBytes: 12,
        createdAt: '2026-09-08',
      },
    ];
    jest.mocked(listAttachmentsForProject).mockResolvedValue(result);
    const handler = handlers.get(IPC_CHANNELS.workspaceAttachmentsList);
    if (!handler) throw new Error('Missing read handler');
    await expect(
      handler(undefined, { projectId: 'project-1', worktreeId: 'wt-1' }),
    ).resolves.toBe(result);
    expect(listAttachmentsForProject).toHaveBeenCalledWith(
      ...['project-1', 'wt-1'],
    );
  });
});
