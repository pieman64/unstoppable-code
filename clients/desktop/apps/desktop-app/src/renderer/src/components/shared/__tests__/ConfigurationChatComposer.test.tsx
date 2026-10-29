/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true });
Object.defineProperty(globalThis, 'structuredClone', {
  configurable: true,
  value: <T,>(value: T): T => value,
});

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, Transforms } from 'slate';
import type { ChatEditor } from '@canopy/ui-rich/types';
import type {
  CanopyApi,
  InvocableInventoryEntry,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type {
  CodexSpeedApi,
  CodexSpeedRouteContext,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import { resetCodexSpeedStoreForTests } from '@/stores/codexSpeedStore';
import {
  buildPluginMentionAbsolutePath,
  PLUGIN_MENTION_KIND,
} from '@canopy/desktop-shared/lib/plugin-mention';
import type { ConfigurationChatComposerValue } from '../ConfigurationChatComposer.types';
import type { ConfigurationComposerContext } from '@/lib/configurationComposerTargets';

jest.mock('@/hooks/useComposerMenu', () => ({
  useComposerMenu: (
    editor: ChatEditor,
    options: { onChange: () => void },
  ): object => ({
    open: false,
    variant: 'add',
    origin: 'toolbar',
    query: '',
    anchorRef: { current: null },
    menuRef: { current: null },
    editorRef: { current: null },
    activeId: null,
    setActiveId: (): void => undefined,
    setHoveredId: (): void => undefined,
    setQuery: (): void => undefined,
    onOpenChange: (): void => undefined,
    consumeTrigger: (): void => undefined,
    beginSelection: (): void => undefined,
    prepareAction: (): void => undefined,
    handleKeyDown: (): boolean => false,
    insertCommandText: (text: string): void => {
      Transforms.select(editor, Editor.end(editor, []));
      Transforms.insertText(editor, text);
      options.onChange();
    },
    insertPlugin: (plugin: {
      marketplaceId: string;
      pluginName: string;
      label: string;
    }): void => {
      Transforms.select(editor, Editor.end(editor, []));
      Transforms.insertNodes(editor, {
        type: 'file-reference',
        displayPath: plugin.label,
        absolutePath: buildPluginMentionAbsolutePath(plugin),
        kind: PLUGIN_MENTION_KIND,
        children: [{ text: '' }],
      });
      options.onChange();
    },
    insertForeignReference: (): void => {
      Transforms.select(editor, Editor.end(editor, []));
      Transforms.insertNodes(editor, {
        type: 'file-reference',
        displayPath: 'README.md',
        absolutePath: 'configured://reference/another-editor/0',
        children: [{ text: '' }],
      });
      options.onChange();
    },
  }),
}));

jest.mock('../ComposerPlusMenu', () => ({
  ComposerPlusMenu: (props: {
    controller: { insertForeignReference: () => void };
    commands: { name: string; section?: string }[];
    onSelectCommand: (command: unknown) => void;
    onSelectPlugin: (
      ref: { marketplaceId: string; pluginName: string },
      meta: { label: string; enabled: boolean },
    ) => void;
  }): JSX.Element => (
    <>
      {props.commands
        .filter((command) => command.section === 'available')
        .map((command) => (
          <button
            key={command.name}
            type="button"
            data-testid={`command-${command.name}`}
            onClick={() => props.onSelectCommand(command)}
          >
            {command.name}
          </button>
        ))}
      <button
        type="button"
        data-testid="foreign-file-pill"
        onClick={() => props.controller.insertForeignReference()}
      >
        Paste foreign file pill
      </button>
      <button
        type="button"
        data-testid="plugin-demo"
        onClick={() =>
          props.onSelectPlugin(
            { marketplaceId: 'market', pluginName: 'demo' },
            { label: 'Demo', enabled: false },
          )
        }
      >
        Demo
      </button>
    </>
  ),
}));
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: (): null => null,
}));
jest.mock('@/components/chat/ApprovalModePicker', () => ({
  ApprovalModePicker: (): null => null,
}));
jest.mock('@/components/chat/ThinkingLevelButton', () => ({
  ThinkingLevelButton: (): null => null,
}));
jest.mock('../ConfigurationComposerVoiceControl', () => ({
  ConfigurationComposerVoiceControl: (): null => null,
}));
jest.mock('@/components/chat/ChatPluginsModal', () => ({
  ChatPluginsModal: (): null => null,
}));
jest.mock('../ShareablePluginSelector', () => ({
  ShareablePluginSelector: (): null => null,
}));

import { ConfigurationChatComposer } from '../ConfigurationChatComposer';

const portable = {
  type: 'plugin' as const,
  marketplace: { type: 'builtin' as const, id: 'app' },
  plugin_name: 'demo',
};
const entry: InvocableInventoryEntry = {
  id: 'claude:demo',
  provider: 'claude',
  kind: 'plugin_command',
  name: 'demo',
  displayName: '/demo',
  description: 'Demo command',
  insertText: '/demo ',
  invocationKey: '/demo',
  enableRef: { kind: 'plugin', marketplaceId: 'market', pluginName: 'demo' },
};

describe('ConfigurationChatComposer source selections', () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: ConfigurationChatComposerValue;
  let resolvePortableEnableRef: jest.Mock;
  let listInventory: jest.Mock;

  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet' }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = { prompt: '' };
    resolvePortableEnableRef = jest.fn(() =>
      Promise.resolve({
        success: true,
        data: portable,
      }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        homeDiscoverEnvironment: jest.fn(() =>
          Promise.resolve({
            discovery: { slashCommands: [], mcpServers: [], discoveredAt: '' },
          }),
        ),
        homeFileIndex: jest.fn(() => Promise.resolve({ repos: [] })),
      } satisfies Partial<CanopyApi>,
    });
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: {
        resolvePortableEnableRef,
        resolvePortableRefs: jest.fn(() =>
          Promise.resolve({
            success: true,
            data: {
              selections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [{ marketplaceId: 'market', pluginName: 'demo' }],
                mcpServerRefs: [],
                mcpHttpAuthPreferences: [],
              },
              unresolved: [],
            },
          }),
        ),
        prepareCodexCompatibilityPlugin: jest.fn(),
      },
    });
    listInventory = jest.fn(() =>
      Promise.resolve({
        success: true,
        data: { entries: [entry], stale: false, rebuilding: false },
      }),
    );
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list: listInventory,
        refresh: jest.fn(() =>
          Promise.resolve({
            success: true,
            data: { entries: [entry], stale: false, rebuilding: false },
          }),
        ),
        onChanged: jest.fn((): (() => void) => () => undefined),
        resolveSelection: jest.fn(() =>
          Promise.resolve({
            success: true,
            data: { insertText: '/demo ' },
          }),
        ),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness(): React.JSX.Element {
    const [value, setValue] = useState<ConfigurationChatComposerValue>({
      prompt: '',
    });
    latest = value;
    return (
      <ConfigurationChatComposer
        editorId="source-action"
        dataTestId="source-prompt"
        value={value}
        onChange={setValue}
        selectionMode="source"
        context={{
          kind: 'workspace',
          workspaceId: 'workspace',
          target: { kind: 'baseline' },
        }}
        effectiveModel="claude-sonnet-4-5"
      />
    );
  }

  it('withholds provider inventory until an existing chat destination resolves', async () => {
    await act(async () => {
      root.render(
        <ConfigurationChatComposer
          editorId="unresolved-chat"
          dataTestId="unresolved-chat-prompt"
          value={{ prompt: 'Draft text' }}
          onChange={jest.fn()}
          selectionMode="local"
          context={{ kind: 'unresolved', reason: 'Loading chat metadata.' }}
          effectiveModel="claude-sonnet-4-5"
        />,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="unresolved-chat-prompt"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="command-demo"]')).toBeNull();
    expect(window.api.homeDiscoverEnvironment).not.toHaveBeenCalled();
  });

  it('shows the destination status message', async () => {
    await act(async () => {
      root.render(
        <ConfigurationChatComposer
          editorId="unresolved-chat"
          dataTestId="unresolved-chat-prompt"
          value={{ prompt: '' }}
          onChange={jest.fn()}
          selectionMode="local"
          context={{ kind: 'unresolved', reason: 'Private project missing.' }}
          effectiveModel="claude-sonnet-4-5"
        />,
      );
      await Promise.resolve();
    });
    const message = Array.from(container.querySelectorAll('*')).find(
      (element) => element.textContent === 'Private project missing.',
    );
    expect(message).toBeDefined();
  });

  it('indexes files but runs no provider discovery for a Cursor destination', async () => {
    // Cursor has no Claude/Codex extension discovery; the destination's files
    // are still indexed so file pills resolve, and the inventory is Cursor's.
    await act(async () => {
      root.render(
        <ConfigurationChatComposer
          editorId="cursor-action"
          dataTestId="cursor-prompt"
          value={{ prompt: '' }}
          onChange={jest.fn()}
          selectionMode="source"
          context={{
            kind: 'workspace',
            workspaceId: 'workspace',
            target: { kind: 'baseline' },
          }}
          effectiveModel="cursor-default"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.api.homeDiscoverEnvironment).not.toHaveBeenCalled();
    expect(window.api.homeFileIndex).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      target: { kind: 'baseline' },
    });
    expect(listInventory).toHaveBeenCalledWith({ providerType: 'cursor' });
  });

  it('saves a portable backing ref and the resolved command invocation without local additions', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="command-demo"]',
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(latest.plugins).toEqual([portable]);
    expect(latest.pluginSelections).toBeUndefined();
    expect(latest.prompt).toContain('/demo');
  });

  it('inserts an inherited Cursor row without writing selections, and stays ready for the next pick', async () => {
    // An inherited row enables nothing: the hook commits with `null`
    // selections, and the composer must still insert the resolved text and
    // clear its pending flag, or every later pick is blocked.
    const inherited: InvocableInventoryEntry = {
      id: 'cursor:inherited_skill:claude:review',
      provider: 'cursor',
      kind: 'inherited_skill',
      name: 'review',
      displayName: '/review',
      description: 'Inherited review',
      insertText: '/review ',
      invocationKey: '/review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    };
    listInventory.mockResolvedValue({
      success: true,
      data: { entries: [inherited], stale: false, rebuilding: false },
    });
    const resolveSelection = jest.fn(() =>
      Promise.resolve({
        success: true,
        data: { insertText: '/review-1 ', invocationKey: '/review-1' },
      }),
    );
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list: listInventory,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
        resolveSelection,
      },
    });
    function LocalCursorHarness(): React.JSX.Element {
      const [value, setValue] = useState<ConfigurationChatComposerValue>({
        prompt: '',
      });
      latest = value;
      return (
        <ConfigurationChatComposer
          editorId="cursor-local-action"
          dataTestId="cursor-local-prompt"
          value={value}
          onChange={setValue}
          selectionMode="local"
          context={{
            kind: 'workspace',
            workspaceId: 'workspace',
            target: { kind: 'baseline' },
          }}
          effectiveModel="cursor-default"
        />
      );
    }
    await act(async () => {
      root.render(<LocalCursorHarness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="command-review"]',
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(resolveSelection).toHaveBeenCalledTimes(1);
    expect(latest.prompt).toContain('/review-1');
    expect(latest.pluginSelections).toBeUndefined();
    expect(latest.plugins).toBeUndefined();

    // Pending cleared: a second pick runs instead of being swallowed.
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(resolveSelection).toHaveBeenCalledTimes(2);
  });

  it('stores a source plugin pill as a portable reference', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-demo"]')
        ?.click();
      await Promise.resolve();
    });
    expect(resolvePortableEnableRef).toHaveBeenCalledWith({
      enableRef: {
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'demo',
      },
      providerType: 'claude',
    });
    expect(latest.plugins).toEqual([portable]);
    expect(latest.promptReferences).toEqual([
      expect.objectContaining({
        kind: 'plugin',
        plugin: { kind: 'portable', ref: portable },
      }),
    ]);
  });

  it('blocks saving when an unowned reference pill is pasted into the editor', async () => {
    const validity = jest.fn<void, [{ valid: boolean; reason?: string }]>();
    function LocalHarness(): React.JSX.Element {
      const [value, setValue] = useState<ConfigurationChatComposerValue>({
        prompt: '',
      });
      return (
        <ConfigurationChatComposer
          editorId="foreign-reference"
          dataTestId="foreign-reference-prompt"
          value={value}
          onChange={setValue}
          selectionMode="local"
          context={{
            kind: 'workspace',
            workspaceId: 'workspace',
            target: { kind: 'baseline' },
          }}
          effectiveModel="claude-sonnet-4-5"
          onValidityChange={validity}
        />
      );
    }
    await act(async () => {
      root.render(<LocalHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="foreign-file-pill"]')
        ?.click();
      await Promise.resolve();
    });
    expect(validity.mock.lastCall?.[0].valid).toBe(false);
    expect(validity.mock.lastCall?.[0].reason).toContain('another composer');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'another composer',
    );
    expect(
      container.querySelector('[data-notice-intent="destructive"]'),
    ).toBeTruthy();
  });

  it('blocks saving a file pill while the selected destination index is pending', async () => {
    const file = {
      absolutePath: '/repo/README.md',
      relativePath: 'README.md',
      filename: 'README.md',
      isIgnored: false,
    };
    const indexed = {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/repo',
          rootKind: 'standalone',
          files: [file],
        },
      ],
    };
    let finishWorktreeIndex: (value: typeof indexed) => void = () => {
      throw new Error('Worktree index did not start');
    };
    const fileIndex = jest.fn((request: { target: { kind: string } }) =>
      request.target.kind === 'baseline'
        ? Promise.resolve(indexed)
        : new Promise<typeof indexed>((resolve) => {
            finishWorktreeIndex = resolve;
          }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        homeDiscoverEnvironment: jest.fn(() =>
          Promise.resolve({ discovery: null }),
        ),
        homeFileIndex: fileIndex,
      },
    });
    const validity = jest.fn();
    function ReferencedHarness(): React.JSX.Element {
      const [context, setContext] = useState<ConfigurationComposerContext>({
        kind: 'workspace',
        workspaceId: 'workspace',
        target: { kind: 'baseline' },
      });
      const [value, setValue] = useState<ConfigurationChatComposerValue>({
        prompt: 'README.md',
        promptReferences: [
          {
            kind: 'file',
            textStart: 0,
            displayText: 'README.md',
            root: { kind: 'workspace' },
            relativePath: 'README.md',
          },
        ],
      });
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setContext({
                kind: 'workspace',
                workspaceId: 'workspace',
                target: { kind: 'worktree', worktreeId: 'other' },
              })
            }
          >
            Change target
          </button>
          <ConfigurationChatComposer
            editorId="referenced"
            dataTestId="referenced-prompt"
            value={value}
            onChange={setValue}
            selectionMode="local"
            context={context}
            effectiveModel="claude-sonnet-4-5"
            onValidityChange={validity}
          />
        </>
      );
    }
    await act(async () => {
      root.render(<ReferencedHarness />);
      await Promise.resolve();
    });
    expect(validity).toHaveBeenLastCalledWith({
      valid: true,
      reason: undefined,
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(validity).toHaveBeenLastCalledWith({
      valid: false,
      reason: 'Checking file references.',
    });
    await act(async () => {
      finishWorktreeIndex({ repos: [] });
      await Promise.resolve();
    });
    expect(validity).toHaveBeenLastCalledWith({
      valid: false,
      reason: 'Resolve or remove missing file references before saving.',
    });
  });
});

describe('ConfigurationChatComposer Codex speed', () => {
  const NOW = Date.parse('2026-09-30T12:00:00.000Z');
  let root: Root;
  let container: HTMLDivElement;
  let latest: ConfigurationChatComposerValue;
  let tiers: string[];

  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet' }]);
    initCodexModels([{ id: 'gpt-9-future', label: 'Future' }]);
    resetCodexSpeedStoreForTests();
    tiers = ['priority'];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = { prompt: '' };
    const codexSpeed: CodexSpeedApi = {
      // The host has not projected this destination's route.
      readRoute: jest.fn(() =>
        Promise.resolve({
          modelSelection: 'explicit' as const,
          runtimeModel: null,
          modelSource: null,
          harness: null,
          routeProfile: 'unknown' as const,
        }),
      ),
      readCapabilities: jest.fn(() =>
        Promise.resolve({
          generation: 1,
          status: 'ready' as const,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + 300_000,
          truncated: false,
          models: [
            {
              id: 'gpt-9-future',
              model: 'gpt-9-future',
              tiers,
              source: 'serviceTiers' as const,
            },
          ],
          denials: [],
        }),
      ),
      setActive: jest.fn(() => Promise.resolve()),
      onChanged: jest.fn(() => (): void => undefined),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        codexSpeed,
        loadPreferences: jest.fn(() => Promise.resolve({})),
        configurationComposerAdvisorEnvironment: jest.fn(() =>
          Promise.resolve({ discovery: null, repos: [] }),
        ),
        homeDiscoverEnvironment: jest.fn(() =>
          Promise.resolve({
            discovery: { slashCommands: [], mcpServers: [], discoveredAt: '' },
          }),
        ),
        homeFileIndex: jest.fn(() => Promise.resolve({ repos: [] })),
      },
    });
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list: jest.fn(() =>
          Promise.resolve({
            success: true,
            data: { entries: [], stale: false, rebuilding: false },
          }),
        ),
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
        resolveSelection: jest.fn(),
      },
    });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCodexSpeedStoreForTests();
    jest.restoreAllMocks();
  });

  function SpeedHarness({
    initial,
    speedRouteContext,
    speedRouteModelSelection,
    composerContext,
  }: {
    initial: ConfigurationChatComposerValue;
    speedRouteContext?: CodexSpeedRouteContext;
    speedRouteModelSelection?: 'explicit' | 'auto';
    composerContext?: ConfigurationComposerContext;
  }): React.JSX.Element {
    const [value, setValue] = useState<ConfigurationChatComposerValue>(initial);
    latest = value;
    return (
      <ConfigurationChatComposer
        editorId="speed-action"
        dataTestId="speed-prompt"
        value={value}
        onChange={setValue}
        selectionMode="local"
        {...{ speedRouteContext, speedRouteModelSelection }}
        context={
          composerContext ?? {
            kind: 'workspace',
            workspaceId: 'workspace',
            target: { kind: 'baseline' },
          }
        }
        effectiveModel="gpt-9-future"
        executionHarness="codex"
      />
    );
  }

  async function renderSpeed(
    initial: ConfigurationChatComposerValue,
    routeProps: {
      speedRouteContext?: CodexSpeedRouteContext;
      speedRouteModelSelection?: 'explicit' | 'auto';
      composerContext?: ConfigurationComposerContext;
    } = {},
  ): Promise<() => HTMLButtonElement | null> {
    await act(async () => {
      root.render(<SpeedHarness initial={initial} {...routeProps} />);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    return () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="speed-prompt-fast-mode"]',
      );
  }

  async function click(button: HTMLButtonElement | null): Promise<void> {
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
  }

  it('shows an inherited speed as Use default and names what it resolves to', async () => {
    const chip = await renderSpeed({ prompt: '' });
    expect(chip()?.textContent).toBe('Use default');
    expect(chip()?.hasAttribute('aria-pressed')).toBe(false);
    expect(chip()?.getAttribute('aria-label')).toBe(
      'Speed: Use default (Regular). Select to use Regular.',
    );
  });

  it('cycles explicit speeds with their derived boolean, then returns to the default', async () => {
    // Even an advertising catalog cannot confirm this action's route: Ultra
    // fast waits for a context-scoped host projection, so the cycle skips it.
    tiers = ['priority', 'ultrafast'];
    const chip = await renderSpeed({
      prompt: '',
      modelConfig: { thinkingLevel: 'high' },
    });
    await click(chip());
    expect(latest.modelConfig).toEqual({
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    });
    await click(chip());
    expect(latest.modelConfig).toMatchObject({ speed: 'fast', fastMode: true });
    expect(chip()?.getAttribute('aria-label')).toBe(
      'Speed: Fast. Select to use the default speed.',
    );
    await click(chip());
    // Use default removes the explicit speed; unrelated settings remain.
    expect(latest.modelConfig).toEqual({ thinkingLevel: 'high' });
  });

  it('skips Ultra fast when the model does not offer it', async () => {
    const chip = await renderSpeed({
      prompt: '',
      modelConfig: { speed: 'fast', fastMode: true },
    });
    await click(chip());
    expect(latest.modelConfig?.speed).toBeUndefined();
    expect(latest.modelConfig?.fastMode).toBeUndefined();
  });

  it('keeps a saved Ultra fast visible with its reason until the user changes it', async () => {
    const chip = await renderSpeed({
      prompt: '',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
    expect(chip()?.textContent).toBe('Ultra fast');
    expect(chip()?.getAttribute('aria-label')).toBe(
      "Speed: Ultra fast, can't run now. Select to use the default speed.",
    );
    expect(latest.modelConfig).toEqual({ speed: 'ultrafast', fastMode: false });
  });

  it('qualifies an existing-chat automation with its canonical billing route', async () => {
    tiers = ['priority', 'ultrafast'];
    const chatContext: CodexSpeedRouteContext = {
      kind: 'chat',
      projectId: 'workspace',
      worktreeId: 'existing',
      chatId: 'chat',
    };
    jest.mocked(window.api.codexSpeed.readRoute).mockImplementation((request) =>
      Promise.resolve({
        modelSelection: 'explicit',
        runtimeModel: 'gpt-9-future',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile:
          request.context.kind === 'chat' ? 'ai-credits' : 'codex-native',
      }),
    );
    const chip = await renderSpeed(
      { prompt: '', modelConfig: { speed: 'fast', fastMode: true } },
      { speedRouteContext: chatContext },
    );
    expect(window.api.codexSpeed.readRoute).toHaveBeenCalledWith({
      context: chatContext,
      model: 'gpt-9-future',
      modelSelection: 'explicit',
    });
    expect(chip()?.getAttribute('aria-label')).toBe(
      'Speed: Fast. Select to use the default speed.',
    );
  });

  it('keeps inherited Auto blocked even when the host profile and catalog are native', async () => {
    tiers = ['priority', 'ultrafast'];
    jest.mocked(window.api.codexSpeed.readRoute).mockResolvedValue({
      modelSelection: 'auto',
      runtimeModel: 'gpt-9-future',
      modelSource: 'codex-managed',
      harness: 'codex',
      routeProfile: 'codex-native',
    });
    const chip = await renderSpeed(
      { prompt: '', modelConfig: { speed: 'fast', fastMode: true } },
      { speedRouteModelSelection: 'auto' },
    );
    expect(chip()?.getAttribute('aria-label')).toBe(
      'Speed: Fast. Select to use the default speed.',
    );
  });

  it('uses the App Advisor environment assignment to qualify its native route', async () => {
    tiers = ['priority', 'ultrafast'];
    jest.mocked(window.api.codexSpeed.readRoute).mockImplementation((request) =>
      Promise.resolve({
        modelSelection: 'explicit',
        runtimeModel: 'gpt-9-future',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile:
          request.context.kind === 'home' &&
          request.context.projectId === APP_ADVISOR_PROJECT_ID
            ? 'codex-native'
            : 'foreign',
      }),
    );
    const chip = await renderSpeed(
      { prompt: '', modelConfig: { speed: 'fast', fastMode: true } },
      { composerContext: { kind: 'advisor' } },
    );
    expect(chip()?.getAttribute('aria-label')).toBe(
      'Speed: Fast. Select to use Ultra fast.',
    );
  });
});
