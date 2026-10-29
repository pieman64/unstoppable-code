// Canonical Codex speed store actions. `chatStore.test.ts` is the natural home
// for these, but it is too large for the delegated edit tooling, so the
// models-slice coverage for the three-state speed lives here.
import {
  initClaudeModels,
  initCodexModels,
  type CodexFastModeToggleRequest,
  type ResolvedAgentModelConfig,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '../../chatStore';
import {
  hasPendingLocalCodexSpeedWrite,
  recordCanonicalCodexSpeedWhilePending,
} from '../codex-speed';
import { emptyWorktreeChat } from '../tab-utils';
import type { ChatTab } from '../types';

const KEY = 'project/worktree';
const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

const toggleCodexFastModeMock = jest.fn<
  Promise<void>,
  [CodexFastModeToggleRequest]
>(() => Promise.resolve());
const changeModelMock = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);

const REGULAR: ResolvedAgentModelConfig = {
  thinkingLevel: 'high',
  speed: 'standard',
  fastMode: false,
};
const FAST: ResolvedAgentModelConfig = {
  thinkingLevel: 'high',
  speed: 'fast',
  fastMode: true,
};
const ULTRA: ResolvedAgentModelConfig = {
  thinkingLevel: 'high',
  speed: 'ultrafast',
  fastMode: false,
};

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 1,
      },
    ],
    status: 'idle',
    error: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: REGULAR,
    fastModeExplicit: false,
    model: 'gpt-5.5',
    providerType: 'codex',
    executionHarness: 'codex',
    codexFastModeEnabled: false,
    ...overrides,
  };
}

function seed(tabs: ChatTab[]): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      [KEY]: {
        ...emptyWorktreeChat(),
        activeTabId: tabs[0]?.id ?? '',
        tabs,
      },
    },
    modelDefaults: null,
  });
}

function currentTab(id = 'chat'): ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats[KEY]?.tabs.find((tab) => tab.id === id);
}

beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  ]);
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          toggleCodexFastMode: toggleCodexFastModeMock,
          changeModel: changeModelMock,
          command: jest.fn(() =>
            Promise.resolve({
              commandId: 'test',
              outcome: 'applied',
              revision: 1,
            }),
          ),
        },
        claudeTerminal: {
          cleanup: jest.fn(() => Promise.resolve()),
          getState: jest.fn(() => Promise.resolve(undefined)),
        },
        discoverWorktreeEnv: jest.fn(() => Promise.resolve()),
      },
    },
  });
});

afterEach(() => {
  useChatStore.setState({ worktreeChats: {}, modelDefaults: null });
});

describe('setSpeed', () => {
  it('sends the exact Ultra fast speed and never a fast boolean', async () => {
    seed([
      makeTab({
        modelConfig: FAST,
        fastModeExplicit: true,
        codexFastModeEnabled: true,
      }),
    ]);

    await useChatStore.getState().setSpeed('ultrafast', TARGET);

    expect(currentTab()?.modelConfig).toEqual(ULTRA);
    expect(currentTab()?.fastModeExplicit).toBe(true);
    expect(currentTab()?.codexFastModeEnabled).toBe(false);
    expect(toggleCodexFastModeMock).toHaveBeenCalledTimes(1);
    expect(toggleCodexFastModeMock).toHaveBeenCalledWith({
      ...TARGET,
      enabled: false,
      speed: 'ultrafast',
    });
  });

  it('keeps thinking level while changing speed', async () => {
    seed([makeTab({ modelConfig: { ...REGULAR, thinkingLevel: 'xhigh' } })]);

    await useChatStore.getState().setSpeed('fast', TARGET);

    expect(currentTab()?.modelConfig).toEqual({
      thinkingLevel: 'xhigh',
      speed: 'fast',
      fastMode: true,
    });
    expect(toggleCodexFastModeMock).toHaveBeenCalledWith({
      ...TARGET,
      enabled: true,
      speed: 'fast',
    });
  });

  it('marks the speed write pending until main settles it', async () => {
    seed([makeTab()]);
    let settle = (): void => {};
    toggleCodexFastModeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const write = useChatStore.getState().setSpeed('fast', TARGET);
    await Promise.resolve();
    expect(toggleCodexFastModeMock).toHaveBeenCalledTimes(1);
    expect(hasPendingLocalCodexSpeedWrite('project', 'worktree', 'chat')).toBe(
      true,
    );

    settle();
    await write;
    expect(hasPendingLocalCodexSpeedWrite('project', 'worktree', 'chat')).toBe(
      false,
    );
  });

  it('shows the last confirmed speed when the newest overlapping write is refused', async () => {
    seed([makeTab()]);
    let settleFirst = (): void => {};
    toggleCodexFastModeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.reject(new Error('refused')));

    const first = useChatStore.getState().setSpeed('fast', TARGET);
    const second = useChatStore.getState().setSpeed('ultrafast', TARGET);
    await expect(second).rejects.toThrow('refused');
    // Main committed Fast; its echo was held back while writes were pending.
    recordCanonicalCodexSpeedWhilePending(
      'project',
      'worktree',
      'chat',
      'fast',
    );
    expect(currentTab()?.modelConfig?.speed).toBe('ultrafast');

    settleFirst();
    await first;
    expect(currentTab()?.modelConfig).toEqual(FAST);
    expect(currentTab()?.codexFastModeEnabled).toBe(true);
  });

  it('rolls a single refused write back to the speed before it', async () => {
    seed([makeTab()]);
    toggleCodexFastModeMock.mockImplementationOnce(() =>
      Promise.reject(new Error('refused')),
    );

    await expect(
      useChatStore.getState().setSpeed('fast', TARGET),
    ).rejects.toThrow('refused');

    expect(currentTab()?.modelConfig).toEqual(REGULAR);
    expect(currentTab()?.codexFastModeEnabled).toBe(false);
  });

  it('ignores non-Codex tabs', async () => {
    const claudeTab = makeTab({
      model: 'claude-sonnet-4-6',
      providerType: 'claude',
      executionHarness: 'claude',
      codexFastModeEnabled: undefined,
    });
    seed([claudeTab]);

    await useChatStore.getState().setSpeed('ultrafast', TARGET);

    expect(currentTab()).toBe(claudeTab);
    expect(toggleCodexFastModeMock).not.toHaveBeenCalled();
  });
});

describe('legacy boolean fast-mode adapters', () => {
  it('setFastMode(false) replaces Ultra fast with Regular', async () => {
    seed([makeTab({ modelConfig: ULTRA, fastModeExplicit: true })]);

    await useChatStore.getState().setFastMode(false, TARGET);

    expect(currentTab()?.modelConfig).toEqual(REGULAR);
    expect(currentTab()?.fastModeExplicit).toBe(true);
    expect(toggleCodexFastModeMock).toHaveBeenCalledWith({
      ...TARGET,
      enabled: false,
      speed: 'standard',
    });
  });

  it('setFastMode(true) replaces Ultra fast with Fast', async () => {
    seed([makeTab({ modelConfig: ULTRA, fastModeExplicit: true })]);

    await useChatStore.getState().setFastMode(true, TARGET);

    expect(currentTab()?.modelConfig).toEqual(FAST);
    expect(currentTab()?.codexFastModeEnabled).toBe(true);
  });

  it('toggleFastMode moves Ultra fast (fastMode false) to Fast', async () => {
    seed([makeTab({ modelConfig: ULTRA, fastModeExplicit: true })]);

    useChatStore.getState().toggleFastMode(TARGET);
    await Promise.resolve();

    expect(currentTab()?.modelConfig).toEqual(FAST);
    expect(toggleCodexFastModeMock).toHaveBeenCalledWith({
      ...TARGET,
      enabled: true,
      speed: 'fast',
    });
  });

  it('toggleFastMode moves Fast to Regular', async () => {
    seed([makeTab({ modelConfig: FAST, fastModeExplicit: true })]);

    useChatStore.getState().toggleCodexFastMode(TARGET);
    await Promise.resolve();

    expect(currentTab()?.modelConfig).toEqual(REGULAR);
    expect(toggleCodexFastModeMock).toHaveBeenCalledWith({
      ...TARGET,
      enabled: false,
      speed: 'standard',
    });
  });
});

describe('model changes', () => {
  it('restores Ultra fast after a Codex → Claude → Codex round trip', async () => {
    seed([
      makeTab({
        modelConfig: ULTRA,
        fastModeExplicit: true,
        codexFastModeEnabled: false,
      }),
    ]);
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'codex',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
        // A different provider default proves the retained choice wins.
        modelConfigDefaultsByProvider: {
          codex: { speed: 'fast', fastMode: true },
        },
      },
    });

    await expect(
      useChatStore.getState().setModelAndWait('claude-sonnet-4-6', TARGET),
    ).resolves.toBe(true);
    expect(currentTab()?.providerType).toBe('claude');
    expect(currentTab()?.modelConfig.speed).toBe('standard');
    expect(currentTab()?.retainedCodexSpeed).toBe('ultrafast');

    await expect(
      useChatStore.getState().setModelAndWait('gpt-5.5', TARGET),
    ).resolves.toBe(true);
    expect(currentTab()?.providerType).toBe('codex');
    expect(currentTab()?.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(currentTab()?.codexFastModeEnabled).toBe(false);
    expect(currentTab()?.fastModeExplicit).toBe(true);
    expect(currentTab()).not.toHaveProperty('retainedCodexSpeed');
  });

  it('uses the Codex default speed when a tab returns without a retained speed', async () => {
    seed([
      makeTab({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        executionHarness: 'claude',
        codexFastModeEnabled: undefined,
      }),
    ]);
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'codex',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
        modelConfigDefaultsByProvider: {
          codex: { speed: 'ultrafast', fastMode: false },
        },
      },
    });

    await useChatStore.getState().setModelAndWait('gpt-5.5', TARGET);

    expect(currentTab()?.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(currentTab()?.codexFastModeEnabled).toBe(false);
  });

  it('preserves the requested speed across a Codex model change', async () => {
    seed([makeTab({ modelConfig: ULTRA, fastModeExplicit: true })]);

    await useChatStore.getState().setModelAndWait('gpt-5.6-luna', TARGET);

    expect(currentTab()?.model).toBe('gpt-5.6-luna');
    expect(currentTab()?.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
  });
});

describe('applyModelConfigDefaults', () => {
  it('propagates an Ultra fast default to non-explicit Codex tabs only', () => {
    const explicitFast = makeTab({
      id: 'explicit',
      modelConfig: FAST,
      fastModeExplicit: true,
      codexFastModeEnabled: true,
    });
    seed([makeTab(), explicitFast]);

    useChatStore.getState().applyModelConfigDefaults({
      codex: { speed: 'ultrafast', fastMode: false },
    });

    expect(currentTab()?.modelConfig).toEqual(ULTRA);
    expect(currentTab()?.codexFastModeEnabled).toBe(false);
    expect(currentTab('explicit')).toBe(explicitFast);
  });

  it('still applies a legacy boolean-only default', () => {
    seed([makeTab()]);

    useChatStore
      .getState()
      .applyModelConfigDefaults({ codex: { fastMode: true } });

    expect(currentTab()?.modelConfig).toEqual(FAST);
    expect(currentTab()?.codexFastModeEnabled).toBe(true);
  });

  it('moves a non-explicit Ultra fast tab back to Regular when the default is cleared', () => {
    seed([makeTab({ modelConfig: ULTRA })]);

    useChatStore.getState().applyModelConfigDefaults({
      codex: { speed: 'standard', fastMode: false },
    });

    expect(currentTab()?.modelConfig).toEqual(REGULAR);
  });
});
