import { join } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { forkOpenWorktreeTabs } from '../worktree-open-tabs-fork';

jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: jest.fn(),
}));
jest.mock('../../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(),
}));
jest.mock('../../panels/persistence', () => ({
  panelLayoutPersistenceStore: {
    loadWorktreeLayout: jest.fn(),
    saveWorktreeLayout: jest.fn(),
  },
}));

// forkOpenWorktreeTabs serves chat:fork-open-worktree-tabs and the Portal branch.
describe('branch fork provenance (CAN-4113)', () => {
  const sourceRoot = join('/root', 'w-src');
  const destinationRoot = join('/root', 'w-dst');
  const request = {
    projectId: 'p',
    sourceWorktreeId: 'w-src',
    destinationWorktreeId: 'w-dst',
    forkPanelLayout: false,
  };
  const chatTab: PersistedChatTab = {
    id: 'c1',
    title: 'Chat',
    createdAt: '2026-11-01T10:00:00.000Z',
    messages: [
      {
        id: 'm1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'See the screenshot' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Looks good' }],
      },
    ],
    model: 'claude-opus-4-6',
    providerType: 'claude',
    modelConfig: { thinkingLevel: 'high' },
    planMode: true,
    approvalMode: 'auto',
    customTitle: 'Mine',
    inputDelivery: {
      version: 1,
      epoch: 0,
      rows: [
        {
          id: 'row-1',
          revision: 1,
          createdAt: 1,
          state: 'picked-up',
          text: 'See the screenshot',
          payload: {
            projectId: 'p',
            worktreeId: 'w-src',
            chatId: 'c1',
            userMessageId: 'row-1',
            text: 'See the screenshot',
            attachmentPaths: ['/attachments/a.png'],
          },
          settingsKey: 'settings',
          attempts: [],
        },
      ],
    },
  };
  const fileTab: PersistedChatTab = {
    kind: 'file',
    id: 'f1',
    title: 'a.ts',
    createdAt: '2026-11-01T10:00:00.000Z',
    messages: [],
    filePath: join(sourceRoot, 'src', 'a.ts'),
  };

  async function branch(): Promise<{
    bindings: Awaited<ReturnType<typeof forkOpenWorktreeTabs>>;
    written: ChatTabsFile | undefined;
    calls: number;
  }> {
    const ids = ['d1', 'd2'];
    const written: ChatTabsFile[] = [];
    const record = (data: ChatTabsFile): Promise<void> => {
      written.push(data);
      return Promise.resolve();
    };
    const writeTabs = jest.fn(
      (_p: string, _w: string, data: ChatTabsFile): Promise<void> =>
        record(data),
    );
    const copyTabs = jest.fn(
      (_r: unknown, data: ChatTabsFile): Promise<void> => record(data),
    );
    const bindings = await forkOpenWorktreeTabs(request, {
      readTabs: () =>
        Promise.resolve({
          version: 1,
          tabs: [structuredClone(chatTab), structuredClone(fileTab)],
          activeTabId: 'c1',
        }),
      writeTabs,
      copyTabs,
      resolveCwd: (_projectId, worktreeId) =>
        worktreeId === 'w-src' ? sourceRoot : destinationRoot,
      getCurrentBranch: () => Promise.resolve('main'),
      forkCodexThread: jest.fn(),
      nextId: () => ids.shift() ?? 'unexpected',
      now: () => new Date('2026-11-05T10:00:00.000Z'),
      loadPanelLayout: jest.fn(),
      savePanelLayout: jest.fn(),
      nextAuxWindowId: jest.fn(),
    });
    return { bindings, written: written[0], calls: written.length };
  }

  it('keeps branch provenance, attachments and settings (CAN-4113)', async () => {
    const { bindings, written, calls } = await branch();
    expect(calls).toBe(1);
    const fork = written?.tabs.find((tab) => tab.id === 'd1');
    expect(fork?.forkedFrom).toEqual({
      projectId: 'p',
      worktreeId: 'w-src',
      chatId: 'c1',
      atMessageId: 'm2',
    });
    expect(fork?.model).toBe(chatTab.model);
    expect(fork?.providerType).toBe(chatTab.providerType);
    expect(fork?.modelConfig).toEqual(chatTab.modelConfig);
    expect(fork?.planMode).toBe(chatTab.planMode);
    expect(fork?.approvalMode).toBe(chatTab.approvalMode);
    expect(
      fork?.inputDelivery?.rows.map((row) => row.payload.attachmentPaths),
    ).toEqual([['/attachments/a.png']]);
    expect(fork?.customTitle).toBeUndefined();
    expect(bindings.get('c1')).toEqual({ destinationTabId: 'd1' });
  });

  it('moves file tabs to the destination checkout', async () => {
    const { bindings, written } = await branch();
    const destinationFilePath = join(destinationRoot, 'src', 'a.ts');
    expect(written?.tabs.find((tab) => tab.id === 'd2')?.filePath).toBe(
      destinationFilePath,
    );
    expect(bindings.get('f1')).toEqual({
      destinationTabId: 'd2',
      destinationFilePath,
    });
  });
});
