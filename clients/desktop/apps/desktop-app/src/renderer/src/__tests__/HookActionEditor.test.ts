/** @jest-environment jsdom */

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'structuredClone', {
  configurable: true,
  value: <T>(value: T): T => value,
});

jest.mock('../components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

jest.mock('../hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): {
    cache: { marketplaces: never[] };
    loading: boolean;
    refresh: jest.Mock;
  } => ({
    cache: { marketplaces: [] },
    loading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock('../hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): {
    entries: never[];
    loading: boolean;
    refresh: jest.Mock;
  } => ({
    entries: [],
    loading: false,
    refresh: jest.fn(),
  }),
}));

import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { initCodexModels } from '@canopy/desktop-shared/types';
import { act, createElement, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShareablePluginRef } from '@canopy/desktop-shared/plugin-refs';
import { HookActionEditor } from '../components/worktree/HookActionEditor';
import type { EditableHooks } from '../lib/editableHooks';
import {
  applyChatModelSelection,
  applyChatPluginSelections,
  applyChatPlugins,
  applyChatThinkingSelection,
  buildCommandAction,
  buildPipelineAction,
  canAddHookAction,
  createBlankHookAction,
  createHookEnvVarInsertion,
  getHookEnvVarDefinitionsForTrigger,
  getThinkingOptions,
  insertTextAtSelection,
  parseActionType,
  retainPipelineInputsForSelection,
  trimHookActionDraft,
  updateChatAction,
  updateCommandAction,
  updatePipelineAction,
} from '../lib/hookActionEditor';

describe('HookActionEditor helpers', () => {
  it('moves each reference occurrence when trimming a hook draft', () => {
    const references = [2, 15].map((textStart) => ({
      kind: 'file' as const,
      root: { kind: 'workspace' as const },
      relativePath: 'README.md',
      displayText: '@README.md',
      textStart,
    }));
    expect(
      trimHookActionDraft({
        type: 'chat',
        prompt: '  @README.md + @README.md  ',
        promptReferences: references,
      }),
    ).toMatchObject({
      prompt: '@README.md + @README.md',
      promptReferences: references.map((ref) => ({
        ...ref,
        textStart: ref.textStart - 2,
      })),
    });
  });

  it('retains reference spans and explicit settings through unrelated edits', () => {
    const action = {
      type: 'chat' as const,
      prompt: 'Read @README.md',
      promptReferences: [
        {
          kind: 'file' as const,
          root: { kind: 'workspace' as const },
          relativePath: 'README.md',
          displayText: '@README.md',
          textStart: 5,
        },
      ],
      planMode: false,
      approvalMode: 'full-access' as const,
    };
    expect(updateChatAction(action, { autoArchive: true })).toEqual({
      ...action,
      autoArchive: true,
    });
    expect(applyChatThinkingSelection(action, 'high')).toEqual({
      ...action,
      modelConfig: { thinkingLevel: 'high' },
    });
  });

  it('filters curated hook rows and downloads only the selected definition', async () => {
    const previousPipelines = window.pipelines;
    const previousApi = window.api;
    const info = (id: string, source: 'bundled' | 'curated'): PipelineInfo => ({
      id,
      source,
      name: source === 'curated' ? 'Curated review' : 'Bundled review',
      description: '',
      icon: '',
      filename: '',
      createdAt: '',
      updatedAt: '',
      readonly: true,
      triggerTypes: ['dispatch'],
      scopes: ['worktree'],
    });
    const bundled = info('review', 'bundled');
    const curated = info('curated:review', 'curated');
    const get = jest.fn((request: { id: string }) =>
      Promise.resolve({
        success: true,
        data: {
          info: request.id === curated.id ? curated : bundled,
          content: { name: 'Review', on: 'dispatch', jobs: {} },
        },
      }),
    );
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest
          .fn()
          .mockResolvedValue({ success: true, data: [bundled, curated] }),
        get,
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest
          .fn()
          .mockResolvedValue({ disabledPipelineIds: [] }),
      },
    });
    let latest: EditableHooks = {
      'pr:create': [
        {
          uiId: 'pipeline-hook',
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
        },
      ],
    };
    function Harness(): JSX.Element {
      const [hooks, setHooks] = useState(latest);
      return createElement(HookActionEditor, {
        hooks,
        onChange: (
          updater: (current: EditableHooks) => EditableHooks,
        ): void => {
          setHooks((current) => {
            latest = updater(current);
            return latest;
          });
        },
        allowDisable: false,
        pluginSelectionMode: 'portable',
      });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Harness));
        await Promise.resolve();
      });
      expect(get).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'curated' }),
      );
      const sourceFilter = container.querySelector<HTMLElement>(
        '[data-testid="hook-workflow-source-filter"]',
      );
      expect(sourceFilter).not.toBeNull();
      await act(async () => {
        sourceFilter?.click();
        await Promise.resolve();
      });
      const filter = document.querySelector<HTMLElement>(
        '[data-testid="hook-workflow-source-curated"]',
      );
      expect(filter).not.toBeNull();
      await act(async () => {
        filter?.click();
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain('Bundled review');
      const row = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Curated review'),
      );
      expect(row).toBeDefined();
      await act(async () => {
        row?.click();
        await Promise.resolve();
      });
      expect(get).toHaveBeenCalledWith({
        id: 'curated:review',
        source: 'curated',
      });
      expect(latest['pr:create']).toEqual([
        expect.objectContaining({ source: 'curated', id: 'curated:review' }),
      ]);
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: previousPipelines,
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('cycles the hook thinking surface through Default, low, and every supported level', async () => {
    function Harness(): JSX.Element {
      const [hooks, setHooks] = useState<EditableHooks>({
        'pr:create': [
          {
            uiId: 'hook-chat-action',
            type: 'chat',
            prompt: 'Review the PR',
          },
        ],
      });
      return createElement(HookActionEditor, {
        hooks,
        onChange: (updater: (current: EditableHooks) => EditableHooks): void =>
          setHooks((current) => updater(current)),
        allowDisable: false,
        pluginSelectionMode: 'portable',
      });
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });

    const thinkingButton = (): HTMLButtonElement => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Thinking:"]',
      );
      if (!button) throw new Error('hook thinking button not found');
      return button;
    };
    const labels = [
      'Default',
      'None',
      'Low',
      'Medium',
      'High',
      'Extra High',
      'Max',
      'Default',
    ];
    labels.forEach((label, index) => {
      expect(thinkingButton().getAttribute('aria-label')).toContain(
        `Thinking: ${label};`,
      );
      if (index < labels.length - 1) {
        act(() => {
          thinkingButton().dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
        });
      }
    });

    act(() => root.unmount());
    container.remove();
  });

  it('clears the next chat draft editor after adding a chat action', async () => {
    let latest: EditableHooks = {};
    function Harness(): JSX.Element {
      const [hooks, setHooks] = useState<EditableHooks>({});
      return createElement(HookActionEditor, {
        hooks,
        onChange: (
          updater: (current: EditableHooks) => EditableHooks,
        ): void => {
          setHooks((current) => {
            latest = updater(current);
            return latest;
          });
        },
        allowDisable: false,
        pluginSelectionMode: 'portable',
      });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Harness));
        await Promise.resolve();
      });
      const addSection = container.querySelector('.border-dashed');
      if (!addSection) throw new Error('new hook action section not found');
      const actionType = addSection.querySelector<HTMLButtonElement>(
        '[data-testid="hook-add-action-type"]',
      );
      if (!actionType) throw new Error('new hook action type not found');
      act(() => actionType.click());
      const chatOption = document.querySelector<HTMLElement>(
        '[role="option"][data-value="chat"]',
      );
      if (!chatOption) throw new Error('chat action type option not found');
      act(() => chatOption.click());
      const editor = (): HTMLElement | null =>
        container.querySelector('[data-testid="hook-chat-draft-pr:create"]');
      expect(editor()).not.toBeNull();
      const plus = container.querySelector<HTMLButtonElement>(
        '[data-testid="hook-chat-draft-pr:create-plus-button"]',
      );
      await act(async () => {
        plus?.click();
        await Promise.resolve();
      });
      const variable = getHookEnvVarDefinitionsForTrigger('pr:create')[0];
      const token = createHookEnvVarInsertion('prompt', variable.name);
      const variableRow = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-action-row]'),
      ).find((button) => button.textContent?.includes(variable.name));
      if (!variableRow) throw new Error('prompt variable row not found');
      await act(async () => {
        variableRow.click();
        await Promise.resolve();
      });
      expect(editor()?.textContent).toContain(token);
      const add = Array.from(addSection.querySelectorAll('button')).find(
        (button) => button.textContent === 'Add action',
      );
      await act(async () => {
        add?.click();
        await Promise.resolve();
      });
      expect(latest['pr:create']).toEqual([
        expect.objectContaining({ type: 'chat', prompt: token }),
      ]);
      expect(editor()?.textContent).not.toContain(token);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="hook-chat-draft-pr:create-plus-button"]',
          )
          ?.click();
        await Promise.resolve();
      });
      const nextVariable = getHookEnvVarDefinitionsForTrigger('pr:create')[1];
      const nextToken = createHookEnvVarInsertion('prompt', nextVariable.name);
      const nextRow = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-action-row]'),
      ).find((button) => button.textContent?.includes(nextVariable.name));
      if (!nextRow) throw new Error('second prompt variable row not found');
      await act(async () => {
        nextRow.click();
        await Promise.resolve();
      });
      await act(async () => {
        add?.click();
        await Promise.resolve();
      });
      expect(latest['pr:create']).toEqual([
        expect.objectContaining({ type: 'chat', prompt: token }),
        expect.objectContaining({ type: 'chat', prompt: nextToken }),
      ]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  beforeEach(() => {
    initCodexModels([{ id: 'gpt-6-sol', label: 'GPT 6 Sol' }]);
  });

  it("preserves canonical 'low' thinking when the model changes", () => {
    // The hook editor's compact thinking picker supports `low` as an active
    // zero-dot level, so model changes must not hoist it to `medium`.
    expect(
      applyChatModelSelection(
        {
          type: 'chat',
          prompt: 'Review the PR',
          model: 'claude-sonnet-4-5-20250929',
          thinking: 'low',
        },
        'gpt-6-sol',
      ),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the PR',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'low' },
    });
  });

  it('preserves UI-selectable thinking levels across model changes', () => {
    expect(
      applyChatModelSelection(
        {
          type: 'chat',
          prompt: 'Review the PR',
          model: 'claude-sonnet-4-5-20250929',
          thinking: 'xhigh',
        },
        'gpt-6-sol',
      ),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the PR',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'xhigh' },
    });
  });

  it('editor dropdown exposes only the UI-selectable thinking levels', () => {
    // `getThinkingOptions` is provider-agnostic now; the editor select renders
    // these plus a "Project default" blank option — verified in the UI
    // component. Canonical `low` is intentionally omitted here.
    expect(getThinkingOptions()).toEqual([
      'off',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it("saves a canonical 'low' thinking selection", () => {
    // The compact thinking picker exposes canonical `low` as zero active dots.
    expect(
      applyChatThinkingSelection(
        {
          type: 'chat',
          prompt: 'Review the PR',
          thinking: 'low',
        },
        'low',
      ),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the PR',
      modelConfig: { thinkingLevel: 'low' },
    });
  });

  it('requires non-empty trimmed content before adding an action', () => {
    expect(
      canAddHookAction({
        type: 'command',
        command: '   ',
      }),
    ).toBe(false);
    expect(
      canAddHookAction({
        type: 'chat',
        prompt: '  Review the PR  ',
      }),
    ).toBe(true);
  });

  it('preserves interactive command state across edits and trimming', () => {
    const builtAction = buildCommandAction(
      ' read name ',
      'command-action',
      undefined,
      true,
    );
    if (builtAction.type !== 'command') {
      throw new Error('Expected buildCommandAction to return a command action');
    }

    expect(
      updateCommandAction(builtAction, { command: 'read answer' }),
    ).toEqual({
      uiId: 'command-action',
      type: 'command',
      command: 'read answer',
      interactive: true,
    });
    expect(
      trimHookActionDraft({
        type: 'command',
        command: ' read name ',
        interactive: true,
      }),
    ).toEqual({
      type: 'command',
      command: 'read name',
      interactive: true,
    });
  });

  it('trims drafts before insertion', () => {
    expect(
      trimHookActionDraft({
        type: 'chat',
        prompt: '  Review the PR  ',
        model: ' gpt-6-sol ',
        thinking: 'medium',
        'if-command': ' test -f "$CANOPY_PR_CURRENT_FILE" ',
      }),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the PR',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'medium' },
      'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
    });
  });

  it('preserves an absent if-command when updating the prompt', () => {
    expect(
      updateChatAction(
        {
          type: 'chat',
          prompt: 'Review the PR',
        },
        {
          prompt: 'Review the latest PR changes',
        },
      ),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the latest PR changes',
    });
  });

  it('preserves the existing if-command when updating the prompt', () => {
    expect(
      updateChatAction(
        {
          type: 'chat',
          prompt: 'Review the PR',
          'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
        },
        {
          prompt: 'Review the latest PR changes',
        },
      ),
    ).toEqual({
      type: 'chat',
      prompt: 'Review the latest PR changes',
      'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
    });
  });

  describe('allowChatConcurrency', () => {
    it('writes allowChatConcurrency=true when explicitly set', () => {
      expect(
        updateChatAction(
          { type: 'chat', prompt: 'Review' },
          { allowChatConcurrency: true },
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        allowChatConcurrency: true,
      });
    });

    it('removes the field when updateChatAction receives undefined', () => {
      expect(
        updateChatAction(
          {
            type: 'chat',
            prompt: 'Review',
            allowChatConcurrency: true,
          },
          { allowChatConcurrency: undefined },
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
      });
    });

    it('preserves allowChatConcurrency across unrelated updates (e.g. prompt)', () => {
      expect(
        updateChatAction(
          {
            type: 'chat',
            prompt: 'Review',
            allowChatConcurrency: true,
          },
          { prompt: 'Review the PR' },
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review the PR',
        allowChatConcurrency: true,
      });
    });

    it('preserves allowChatConcurrency across model and thinking changes', () => {
      const withModel = applyChatModelSelection(
        {
          type: 'chat',
          prompt: 'Review',
          allowChatConcurrency: true,
        },
        'gpt-6-sol',
      );
      expect(withModel).toMatchObject({ allowChatConcurrency: true });

      const withThinking = applyChatThinkingSelection(
        {
          type: 'chat',
          prompt: 'Review',
          allowChatConcurrency: true,
        },
        'high',
      );
      expect(withThinking).toMatchObject({ allowChatConcurrency: true });
    });

    it('drops allowChatConcurrency from trimHookActionDraft when absent or false', () => {
      expect(
        trimHookActionDraft({
          type: 'chat',
          prompt: 'Review',
        }),
      ).toEqual({ type: 'chat', prompt: 'Review' });
    });

    it('preserves allowChatConcurrency=true through trimHookActionDraft', () => {
      expect(
        trimHookActionDraft({
          type: 'chat',
          prompt: '  Review  ',
          allowChatConcurrency: true,
        }),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        allowChatConcurrency: true,
      });
    });
  });

  it('formats env var insertions for commands and prompts', () => {
    expect(createHookEnvVarInsertion('command', 'CANOPY_PR_URL')).toBe(
      '$CANOPY_PR_URL',
    );
    expect(createHookEnvVarInsertion('prompt', 'CANOPY_PR_URL')).toBe(
      '{{CANOPY_PR_URL}}',
    );
  });

  it('scopes hook variable suggestions by trigger type', () => {
    const precommitNames = getHookEnvVarDefinitionsForTrigger(
      'worktree:precommit:failure',
    ).map((definition) => definition.name);
    expect(precommitNames).toContain('CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR');
    expect(precommitNames).toContain(
      'CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE',
    );
    expect(precommitNames).not.toContain('CANOPY_PR_CURRENT_FILE');
    expect(precommitNames).not.toContain('CANOPY_PR_URL');

    const prNames = getHookEnvVarDefinitionsForTrigger('pr:create').map(
      (definition) => definition.name,
    );
    expect(prNames).toContain('CANOPY_PR_CURRENT_FILE');
    expect(prNames).toContain('CANOPY_PR_URL');
    expect(prNames).not.toContain('CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR');
    expect(prNames).not.toContain(
      'CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE',
    );
    expect(prNames).not.toContain('CANOPY_PR_QUEUE_ENTRY_ID');
    expect(prNames).not.toContain('CANOPY_PR_QUEUE_REMOVAL_REASON');
    expect(precommitNames).not.toContain('CANOPY_PR_QUEUE_ENTRY_ID');

    for (const trigger of ['pr:queue:entered', 'pr:queue:removed']) {
      const queueNames = getHookEnvVarDefinitionsForTrigger(trigger).map(
        (definition) => definition.name,
      );
      expect(queueNames).toContain('CANOPY_PR_URL');
      expect(queueNames).toContain('CANOPY_PR_QUEUE_ENTRY_ID');
      expect(queueNames).toContain('CANOPY_PR_QUEUE_REMOVAL_REASON');
    }
  });

  it('inserts text at the current selection', () => {
    expect(
      insertTextAtSelection({
        value: 'echo ',
        insertedText: '$CANOPY_PR_URL',
        selectionStart: 5,
        selectionEnd: 5,
      }),
    ).toEqual({
      value: 'echo $CANOPY_PR_URL',
      cursorPosition: 19,
    });
  });

  describe('chat plugin refs', () => {
    const skillRef: ShareablePluginRef = {
      type: 'skill',
      source: { type: 'github', repo: 'acme/skills' },
      skill_name: 'commit-messages',
    };
    const pluginRef: ShareablePluginRef = {
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'acme/marketplace' },
      plugin_name: 'browser',
    };

    it('preserves plugin refs through updateChatAction', () => {
      expect(
        updateChatAction(
          {
            type: 'chat',
            prompt: 'Review',
            plugins: [skillRef],
          },
          { prompt: 'Review the latest changes' },
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review the latest changes',
        plugins: [skillRef],
      });
    });

    it('preserves plugin refs when changing the model', () => {
      expect(
        applyChatModelSelection(
          {
            type: 'chat',
            prompt: 'Review',
            plugins: [skillRef, pluginRef],
          },
          'gpt-6-sol',
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        model: 'gpt-6-sol',
        plugins: [skillRef, pluginRef],
      });
    });

    it('dedupes plugin refs by canonical key in applyChatPlugins', () => {
      const duplicateSkill: ShareablePluginRef = {
        type: 'skill',
        // Different casing — same canonical key.
        source: { type: 'github', repo: 'ACME/Skills' },
        skill_name: 'commit-messages',
      };

      expect(
        applyChatPlugins({ type: 'chat', prompt: 'Review' }, [
          skillRef,
          duplicateSkill,
          pluginRef,
        ]),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        plugins: [skillRef, pluginRef],
      });
    });

    it('drops the plugins field entirely when the resulting list is empty', () => {
      expect(
        applyChatPlugins(
          { type: 'chat', prompt: 'Review', plugins: [skillRef] },
          [],
        ),
      ).toEqual({ type: 'chat', prompt: 'Review' });
    });

    it('preserves plugin refs through trimHookActionDraft', () => {
      expect(
        trimHookActionDraft({
          type: 'chat',
          prompt: '  Review  ',
          plugins: [skillRef],
        }),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        plugins: [skillRef],
      });
    });

    it('is a no-op when applyChatPlugins is called on a command action', () => {
      const commandAction = { type: 'command' as const, command: 'echo hi' };
      expect(applyChatPlugins(commandAction, [skillRef])).toBe(commandAction);
    });

    it('stores and preserves full hook plugin selections', () => {
      const pluginSelections = {
        collectionIds: ['collection-1'],
        skillRefs: [
          { sourceId: 'custom:local', skillName: 'release-checklist' },
        ],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
      };
      const configured = applyChatPluginSelections(
        { type: 'chat', prompt: 'Review' },
        pluginSelections,
      );
      expect(configured).toEqual({
        type: 'chat',
        prompt: 'Review',
        pluginSelections,
      });
      expect(applyChatModelSelection(configured, 'gpt-6-sol')).toEqual({
        type: 'chat',
        prompt: 'Review',
        model: 'gpt-6-sol',
        pluginSelections,
      });
    });

    it('preserves local overlay metadata while editing plugin selections', () => {
      expect(
        applyChatPluginSelections(
          {
            type: 'chat',
            prompt: 'Review',
            localPluginSelectionOverlay: true,
            localPluginSelectionOverlayKey: 'chat:Review',
          },
          {
            collectionIds: ['collection-1'],
            skillRefs: [],
            pluginRefs: [],
          },
        ),
      ).toEqual({
        type: 'chat',
        prompt: 'Review',
        localPluginSelectionOverlay: true,
        localPluginSelectionOverlayKey: 'chat:Review',
        pluginSelections: {
          collectionIds: ['collection-1'],
          skillRefs: [],
          pluginRefs: [],
        },
      });
    });
  });

  describe('pipeline actions', () => {
    it('parses pipeline as a recognized action type', () => {
      expect(parseActionType('pipeline')).toBe('pipeline');
    });

    it('createBlankHookAction("pipeline") seeds bundled/empty/inputs={}', () => {
      expect(createBlankHookAction('pipeline')).toEqual({
        type: 'pipeline',
        source: 'bundled',
        id: '',
        inputs: {},
      });
    });

    it('canAddHookAction requires non-empty trimmed id and a valid source', () => {
      expect(
        canAddHookAction({
          type: 'pipeline',
          source: 'bundled',
          id: '   ',
        }),
      ).toBe(false);
      expect(
        canAddHookAction({
          type: 'pipeline',
          source: 'bundled',
          id: 'plan-review',
        }),
      ).toBe(true);
      const invalidSourceAction = {
        type: 'pipeline',
        source: 'bundled',
        id: 'plan-review',
      } satisfies Parameters<typeof canAddHookAction>[0];
      Object.defineProperty(invalidSourceAction, 'source', {
        value: 'unknown',
      });
      expect(canAddHookAction(invalidSourceAction)).toBe(false);
    });

    it('buildPipelineAction preserves uiId, inputs, and concurrency true', () => {
      expect(
        buildPipelineAction(
          'bundled',
          'code-review',
          { pr_url: '{{CANOPY_PR_URL}}' },
          'hook-action-1',
          true,
        ),
      ).toEqual({
        uiId: 'hook-action-1',
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: { pr_url: '{{CANOPY_PR_URL}}' },
        allowPipelineConcurrency: true,
      });
    });

    it('buildPipelineAction omits empty inputs and absent concurrency flag', () => {
      expect(
        buildPipelineAction('local', 'plan-review', undefined, 'hook-action-2'),
      ).toEqual({
        uiId: 'hook-action-2',
        type: 'pipeline',
        source: 'local',
        id: 'plan-review',
      });
    });

    it('updatePipelineAction merges updates and preserves untouched fields', () => {
      expect(
        updatePipelineAction(
          {
            uiId: 'hook-action-3',
            type: 'pipeline',
            source: 'bundled',
            id: 'plan-review',
            inputs: { pr_url: 'https://example.test' },
            allowPipelineConcurrency: true,
          },
          { id: 'code-review' },
        ),
      ).toEqual({
        uiId: 'hook-action-3',
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: { pr_url: 'https://example.test' },
        allowPipelineConcurrency: true,
      });
    });

    it('updatePipelineAction strips concurrency when set to undefined', () => {
      expect(
        updatePipelineAction(
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'code-review',
            allowPipelineConcurrency: true,
          },
          { allowPipelineConcurrency: undefined },
        ),
      ).toEqual({
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
      });
    });

    it('updatePipelineAction can clear inputs by passing undefined', () => {
      expect(
        updatePipelineAction(
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'code-review',
            inputs: { pr_url: '{{CANOPY_PR_URL}}' },
          },
          { inputs: undefined },
        ),
      ).toEqual({
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
      });
    });

    it('trimHookActionDraft trims the id, drops blank input keys and values, and preserves concurrency=true', () => {
      expect(
        trimHookActionDraft({
          type: 'pipeline',
          source: 'bundled',
          id: '  code-review  ',
          inputs: {
            pr_url: '{{CANOPY_PR_URL}}',
            '   ': 'noise',
            '  trimmed_key  ': 'value',
            unset_optional: '',
          },
          allowPipelineConcurrency: true,
        }),
      ).toEqual({
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: {
          pr_url: '{{CANOPY_PR_URL}}',
          trimmed_key: 'value',
        },
        allowPipelineConcurrency: true,
      });
    });

    it('trimHookActionDraft drops allowPipelineConcurrency when absent or false', () => {
      expect(
        trimHookActionDraft({
          type: 'pipeline',
          source: 'local',
          id: 'plan-review',
        }),
      ).toEqual({
        type: 'pipeline',
        source: 'local',
        id: 'plan-review',
      });
    });

    it('retainPipelineInputsForSelection seeds required boolean and choice inputs', () => {
      expect(
        retainPipelineInputsForSelection({
          currentInputs: undefined,
          nextDefs: [
            [
              'required_review',
              {
                required: true,
                type: 'boolean',
              },
            ],
            [
              'review_mode',
              {
                required: true,
                type: 'choice',
                options: ['summary', 'full'],
              },
            ],
          ],
        }),
      ).toEqual({
        required_review: 'false',
        review_mode: 'summary',
      });
    });

    it('retainPipelineInputsForSelection replaces empty required typed inputs with seeded defaults', () => {
      expect(
        retainPipelineInputsForSelection({
          currentInputs: {
            required_review: '',
            review_mode: '',
            pr_url: '{{CANOPY_PR_URL}}',
          },
          nextDefs: [
            [
              'required_review',
              {
                required: true,
                type: 'boolean',
              },
            ],
            [
              'review_mode',
              {
                required: true,
                type: 'choice',
                options: ['summary', 'full'],
              },
            ],
            [
              'pr_url',
              {
                required: true,
              },
            ],
          ],
        }),
      ).toEqual({
        required_review: 'false',
        review_mode: 'summary',
        pr_url: '{{CANOPY_PR_URL}}',
      });
    });

    it('uses {{VAR}} insertion tokens for pipeline input values', () => {
      // Pipeline input values use prompt-style interpolation just like chat
      // prompts, so the insertion helper must produce `{{VAR}}` rather than
      // command-style `$VAR`.
      const inserted = createHookEnvVarInsertion('prompt', 'CANOPY_PR_URL');
      expect(inserted).toBe('{{CANOPY_PR_URL}}');

      const result = insertTextAtSelection({
        value: 'pr=',
        insertedText: inserted,
        selectionStart: 3,
        selectionEnd: 3,
      });
      expect(result).toEqual({
        value: 'pr={{CANOPY_PR_URL}}',
        cursorPosition: 'pr={{CANOPY_PR_URL}}'.length,
      });
    });
  });
});
