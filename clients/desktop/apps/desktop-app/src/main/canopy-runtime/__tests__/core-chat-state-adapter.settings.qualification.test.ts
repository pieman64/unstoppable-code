import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  CanopyQueryResult,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import { CoreChatSnapshotGetResultSchema } from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

const scope = { workspaceId: 'project-1', worktreeId: 'worktree-1' };

const defaults = {
  model: null,
  providerId: null,
  executionHarness: null,
  modelSelectionMode: 'manual',
  thinkingLevel: null,
  speed: null,
  planMode: false,
  approvalMode: null,
  interfaceMode: null,
  customTitle: null,
};

function chatTab(
  id: string,
  fields: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-11-05T00:00:00.000Z',
    messages: [],
    ...fields,
  };
}

function snapshotOf(tabs: PersistedChatTab[]): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision: 3,
    tabsFile: { version: 1, activeTabId: tabs[0]?.id ?? '', tabs },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

function createPort(
  snapshot: ChatStateSnapshot,
  listeners = new Set<(event: ChatStateChangedEvent) => void>(),
): ChatStateCommandPort {
  return {
    getState: jest.fn().mockResolvedValue(snapshot),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn((listener: (event: ChatStateChangedEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
}

async function readSnapshot(
  tabs: PersistedChatTab[],
): Promise<CanopyQueryResult<'core.chat.snapshot.get'>> {
  const runtime = createDesktopRuntime({
    getChatStatePort: () => createPort(snapshotOf(tabs)),
  });
  try {
    return await runtime.query('core.chat.snapshot.get', { scope }, { caller });
  } finally {
    await runtime.shutdown();
  }
}

describe('chat snapshot settings and TODO projection (CAN-4110)', () => {
  it("projects each chat tab's committed settings", async () => {
    const result = await readSnapshot([
      chatTab('chat-1', {
        model: 'gpt-5.5-codex',
        providerType: 'codex',
        executionHarness: 'codex',
        modelSelectionMode: 'auto',
        modelConfig: { thinkingLevel: 'high', speed: 'ultrafast' },
        planMode: true,
        approvalMode: 'auto',
        interfaceMode: 'canopy',
        customTitle: 'Renamed',
      }),
    ]);
    expect(result.tabs.items[0]?.settings).toEqual({
      model: 'gpt-5.5-codex',
      providerId: 'codex',
      executionHarness: 'codex',
      modelSelectionMode: 'auto',
      thinkingLevel: 'high',
      speed: 'ultrafast',
      planMode: true,
      approvalMode: 'auto',
      interfaceMode: 'canopy',
      customTitle: 'Renamed',
    });
    expect(() => CoreChatSnapshotGetResultSchema.parse(result)).not.toThrow();
  });

  it('reads the legacy fast-mode boolean when no speed is stored', async () => {
    const result = await readSnapshot([
      chatTab('fast', { modelConfig: { fastMode: true } }),
      chatTab('standard', { modelConfig: { fastMode: false } }),
      chatTab('unset', { modelConfig: {} }),
      chatTab('bare'),
      chatTab('legacy-fast', { codexFastModeEnabled: true }),
      chatTab('legacy-standard', { codexFastModeEnabled: false }),
      chatTab('config-wins', {
        modelConfig: { fastMode: false },
        codexFastModeEnabled: true,
      }),
    ]);
    const settings = Object.fromEntries(
      result.tabs.items.map((item) => [item.chatId, item.settings]),
    );
    expect(settings.fast?.speed).toBe('fast');
    expect(settings.standard?.speed).toBe('standard');
    expect(settings.unset?.speed).toBeNull();
    expect(settings.bare).toEqual(defaults);
    expect(settings['legacy-fast']?.speed).toBe('fast');
    expect(settings['legacy-standard']?.speed).toBe('standard');
    expect(settings['config-wins']?.speed).toBe('standard');
  });

  it("projects the current turn's TODO items", async () => {
    const result = await readSnapshot([
      chatTab('with-todos', {
        transcript: {
          todos: [
            {
              id: 't1',
              content: 'Write tests',
              status: 'in_progress',
              extra: 'dropped',
            },
          ],
        },
      } as unknown as Partial<PersistedChatTab>),
      chatTab('without-todos', {
        transcript: {},
      } as unknown as Partial<PersistedChatTab>),
    ]);
    expect(result.tabs.items[0]?.todos).toEqual([
      { id: 't1', content: 'Write tests', status: 'in_progress' },
    ]);
    expect(result.tabs.items[1]).not.toHaveProperty('todos');
  });

  it('skips TODO items whose id the portable schema cannot carry', async () => {
    const result = await readSnapshot([
      chatTab('odd-ids', {
        transcript: {
          todos: [
            { id: '', content: 'Empty id', status: 'pending' },
            { id: 'ok', content: 'Kept', status: 'pending' },
          ],
          taskTodos: [
            {
              id: `task:${'x'.repeat(600)}`,
              content: 'Long id',
              status: 'pending',
            },
          ],
        },
      } as unknown as Partial<PersistedChatTab>),
    ]);
    expect(result.tabs.items[0]?.todos).toEqual([
      { id: 'ok', content: 'Kept', status: 'pending' },
    ]);
    expect(result.tabs.items[0]?.taskTodos).toEqual([]);
  });

  it('gives file tabs no settings', async () => {
    const result = await readSnapshot([
      chatTab('file-1', {
        kind: 'file',
        filePath: '/private/worktree/file.ts',
        transcript: {
          todos: [{ id: 't1', content: 'x', status: 'pending' }],
        },
      } as unknown as Partial<PersistedChatTab>),
    ]);
    const item = result.tabs.items[0];
    expect(item).not.toHaveProperty('settings');
    expect(item).not.toHaveProperty('todos');
    expect(item).not.toHaveProperty('taskTodos');
  });

  it('streams model config and interface mode with tab upserts', async () => {
    const listeners = new Set<(event: ChatStateChangedEvent) => void>();
    const port = createPort(snapshotOf([]), listeners);
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const stream = await runtime.openStream(
      'core.chat.events',
      { scope: 'all' },
      { caller },
    );
    try {
      const frames = stream.frames[Symbol.asyncIterator]();
      const event: ChatStateChangedEvent = {
        schemaVersion: 1,
        eventId: 'upsert-1',
        occurredAt: '2026-11-05T00:00:00.000Z',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        baseRevision: 0,
        revision: 1,
        changes: [
          {
            type: 'tab.upserted',
            tab: chatTab('chat-1', {
              modelConfig: { speed: 'fast', fastMode: true },
              interfaceMode: 'claude-code',
            }),
          },
        ],
      };
      listeners.forEach((listener) => listener(event));
      const next = await frames.next();
      const frame = next.value as ChatFrame;
      if (frame.kind !== 'item') throw new Error('Expected a chat event item.');
      expect(frame.item.changes[0]).toMatchObject({
        type: 'tab.upserted',
        tab: {
          id: 'chat-1',
          modelConfig: { speed: 'fast', fastMode: true },
          interfaceMode: 'claude-code',
        },
      });
    } finally {
      stream.close();
      await runtime.shutdown();
    }
  });
});
