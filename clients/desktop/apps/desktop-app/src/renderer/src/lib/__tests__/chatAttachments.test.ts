import {
  createClipboardAttachments,
  importChatAttachments,
} from '../chatAttachments';
import { registerCoworkWorkspaceIds } from '../cowork-registry';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';

interface MockApi {
  importWorktreeAttachments: jest.Mock;
  workspaceItems: {
    importAttachments: jest.Mock;
    listAttachments: jest.Mock;
  };
}

let api: MockApi;

beforeEach(() => {
  api = {
    importWorktreeAttachments: jest.fn(),
    workspaceItems: {
      importAttachments: jest.fn(),
      listAttachments: jest.fn(),
    },
  };
  useWorkspaceItemsStore.setState({ attachments: {} });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api },
  });
});

function fakeFile(name: string, type: string, bytes: number[]): File {
  return {
    name,
    type,
    arrayBuffer: (): Promise<ArrayBuffer> =>
      Promise.resolve(new Uint8Array(bytes).buffer),
  } as unknown as File;
}

describe('importChatAttachments (regression)', () => {
  it('routes worktree projects to importWorktreeAttachments', async () => {
    api.importWorktreeAttachments.mockResolvedValue({
      attachments: [{ filename: 'a.png', absolutePath: '/wt/a.png' }],
    });
    api.workspaceItems.listAttachments.mockResolvedValue([
      {
        filename: 'a.png',
        absolutePath: '/wt/a.png',
        sizeBytes: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await importChatAttachments(
      { projectId: 'proj', worktreeId: 'wt' },
      ['/tmp/a.png'],
    );

    expect(api.importWorktreeAttachments).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      filePaths: ['/tmp/a.png'],
      clipboardItems: undefined,
    });
    expect(api.workspaceItems.listAttachments).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
    });
    expect(useWorkspaceItemsStore.getState().attachments['proj/wt']).toEqual([
      {
        filename: 'a.png',
        absolutePath: '/wt/a.png',
        sizeBytes: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(result).toEqual([{ filename: 'a.png', absolutePath: '/wt/a.png' }]);
  });

  it('routes a cowork project chat to workspaceItems.importAttachments and maps results', async () => {
    // Cowork chats key as (workspaceId, 'home'); the import must go through
    // the workspace-items attachment IPC with the workspace id, not
    // importWorktreeAttachments.
    registerCoworkWorkspaceIds(['cowork-default']);
    api.workspaceItems.importAttachments.mockResolvedValue({
      attachments: [
        {
          filename: 'b.png',
          absolutePath: '/sc/b.png',
          sizeBytes: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    api.workspaceItems.listAttachments.mockResolvedValue([
      {
        filename: 'b.png',
        absolutePath: '/sc/b.png',
        sizeBytes: 4,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await importChatAttachments(
      { projectId: 'cowork-default', worktreeId: 'home' },
      [],
      [{ filename: 'b.png', data: new Uint8Array([1, 2, 3, 4]) }],
    );

    expect(api.workspaceItems.importAttachments).toHaveBeenCalledWith({
      projectId: 'cowork-default',
      worktreeId: 'home',
      filePaths: [],
      clipboardItems: [
        { filename: 'b.png', data: new Uint8Array([1, 2, 3, 4]) },
      ],
    });
    expect(api.workspaceItems.listAttachments).toHaveBeenCalledWith({
      projectId: 'cowork-default',
      worktreeId: 'home',
    });
    expect(
      useWorkspaceItemsStore.getState().attachments['cowork-default/home'],
    ).toEqual([
      {
        filename: 'b.png',
        absolutePath: '/sc/b.png',
        sizeBytes: 4,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(result).toEqual([
      { filename: 'b.png', absolutePath: '/sc/b.png', sizeBytes: 4 },
    ]);
  });
});

describe('createClipboardAttachments (regression)', () => {
  it('converts files to clipboard attachment data preserving filename', async () => {
    const result = await createClipboardAttachments(
      [fakeFile('shot.png', 'image/png', [1, 2, 3])],
      'clipboard-image',
    );
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('shot.png');
    expect(Array.from(result[0].data)).toEqual([1, 2, 3]);
  });

  it('falls back to a basename + extension when the file has no name', async () => {
    const result = await createClipboardAttachments(
      [fakeFile('', 'image/png', [9])],
      'clipboard-image',
    );
    expect(result[0].filename).toBe('clipboard-image.png');
  });

  it('returns an empty array for no files', async () => {
    expect(await createClipboardAttachments([], 'x')).toEqual([]);
  });
});
