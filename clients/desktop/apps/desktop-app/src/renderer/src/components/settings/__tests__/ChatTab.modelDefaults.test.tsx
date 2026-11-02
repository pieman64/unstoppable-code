/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resetGatewayCatalogHydrationForTests,
  type ModelDefaultsByProvider,
  type PreferencesData,
  type ProviderModelSelection,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { ProviderAvailability } from '@/hooks/useProviderAvailability';
import type { AiCreditsAvailability } from '@/hooks/useAiCreditsAvailability';
import { makeTestPreferences } from '@/test-utils/preferences';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { ChatTab } from '../ChatTab';
import {
  querySettingsSelect,
  settingsSelectGroupLabels,
  type SettingsSelectProbe,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('@/hooks/useProviderAvailability', () => {
  const lane = {
    selectable: true,
    nativeAuth: true,
    creditsEligible: false,
    loading: false,
    creditsLoading: false,
  };
  return {
    useProviderAvailability: (): ProviderAvailability => ({
      claude: lane,
      codex: lane,
      ollama: lane,
      opencode: lane,
      cursor: lane,
      copilot: lane,
    }),
  };
});

jest.mock('@/hooks/useAiCreditsAvailability', () => ({
  useAiCreditsAvailability: (): AiCreditsAvailability => ({
    eligible: false,
    loading: false,
    inconclusive: false,
  }),
}));

jest.mock('../SettingsPluginPicker', () => ({
  SettingsPluginPicker: (): null => null,
}));

describe('ChatTab model defaults', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'haiku', label: 'Haiku 4.5' },
    ]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initOllamaModels([
      {
        id: 'ollama-acme-private:latest',
        rawModelId: 'acme-private:latest',
        label: 'acme-private:latest',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    previousApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue(
          makeTestPreferences({
            defaultWorktreeModelByProvider: {
              // A saved model the registries no longer list.
              claude: { model: 'claude-retired-model', thinkingLevel: 'off' },
              codex: { model: 'gpt-5.5', thinkingLevel: 'off' },
              ollama: {
                model: 'ollama-acme-private:latest',
                thinkingLevel: 'off',
              },
            },
          }),
        ),
        savePreferences: jest.fn().mockResolvedValue(undefined),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (previousApi) Object.defineProperty(window, 'api', previousApi);
    else Reflect.deleteProperty(window, 'api');
    initOllamaModels([]);
  });

  it('lists local Ollama and unavailable saved models in the default pickers', async () => {
    await act(async () => {
      root.render(<ChatTab />);
      await Promise.resolve();
    });

    const ollamaModel = querySettingsSelect(
      container,
      '[data-testid="chat-defaults-row-ollama"] button[role="combobox"]',
    );
    expect(
      ollamaModel?.options.some(
        (option) => option.value === 'ollama-acme-private:latest',
      ),
    ).toBe(true);

    const claudeModel = querySettingsSelect(
      container,
      '[data-testid="chat-defaults-row-claude"] button[role="combobox"]',
    );
    expect(
      claudeModel?.options.find(
        (option) => option.value === 'claude-retired-model',
      )?.textContent,
    ).toBe('claude-retired-model (unavailable)');
  });

  async function renderChatTab(): Promise<void> {
    await act(async () => {
      root.render(<ChatTab />);
      await Promise.resolve();
    });
  }

  function requireSelect(testId: string): SettingsSelectProbe {
    const select = querySettingsSelect(container, `[data-testid="${testId}"]`);
    if (!select) throw new Error(`${testId} select missing`);
    return select;
  }

  function rowLabels(): string[] {
    return Array.from(
      container.querySelectorAll('[data-settings-row-label]'),
      (label) => label.textContent ?? '',
    );
  }

  /** The label/description/control line of the settings row titled `label`. */
  function requireRow(label: string): HTMLElement {
    const heading = Array.from(
      container.querySelectorAll('[data-settings-row-label]'),
    ).find((element) => element.textContent === label);
    const row = heading?.parentElement?.parentElement;
    if (!row) throw new Error(`${label} row missing`);
    return row;
  }

  function changeSelect(select: SettingsSelectProbe, value: string): void {
    select.choose(value);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function savedPatches(): Record<string, unknown>[] {
    const api: unknown = Reflect.get(window, 'api');
    const savePreferences: unknown = isRecord(api)
      ? api.savePreferences
      : undefined;
    if (!jest.isMockFunction(savePreferences)) {
      throw new Error('savePreferences mock missing');
    }
    return savePreferences.mock.calls.map((call: unknown[]) => {
      const patch = call[0];
      if (!isRecord(patch)) throw new Error('preference patch missing');
      return patch;
    });
  }

  it('labels the title, handoff, and worktree activity model rows', async () => {
    await renderChatTab();

    const labels = rowLabels();
    const titleIndex = labels.indexOf('Chat title model');
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(labels[titleIndex + 1]).toBe('Conversation handoff model');
    expect(labels).toContain('Worktree activity summary model');
    expect(labels).not.toContain('Chat description model');
    expect(labels).not.toContain('Summary model');

    expect(requireRow('Chat title model').textContent).toContain(
      'Generates names for chat tabs.',
    );
    const handoffRow = requireRow('Conversation handoff model');
    expect(handoffRow.textContent).toContain(
      'Summarizes conversations for provider switching, session recovery, and continuation from archived chats.',
    );
    expect(
      handoffRow.querySelector(
        '[data-testid="settings-handoff-summary-model"]',
      ),
    ).not.toBeNull();
    expect(requireRow('Worktree activity summary model').textContent).toContain(
      'Generates activity-panel summaries covering the whole worktree.',
    );
    expect(container.textContent).not.toContain(
      'Separate from chat tab titles.',
    );
  });

  it('shows the Haiku handoff default and offers Ollama but not Cursor', async () => {
    await renderChatTab();

    const handoffModel = requireSelect('settings-handoff-summary-model');
    expect(handoffModel.value).toBe('haiku');
    expect(
      handoffModel.options.some(
        (option) => option.value === 'ollama-acme-private:latest',
      ),
    ).toBe(true);
    expect(settingsSelectGroupLabels(handoffModel.trigger)).toEqual([
      'Claude',
      'Codex',
      'Ollama',
    ]);
    expect(requireSelect('settings-handoff-summary-thinking').value).toBe(
      'off',
    );
  });

  it('saves only the handoff model and thinking keys', async () => {
    await renderChatTab();

    changeSelect(
      requireSelect('settings-handoff-summary-model'),
      'ollama-acme-private:latest',
    );
    const thinking = requireSelect('settings-handoff-summary-thinking');
    const nextThinking = Array.from(thinking.options)
      .map((option) => option.value)
      .find((value) => value !== thinking.value);
    if (!nextThinking) throw new Error('no alternate thinking level');
    changeSelect(thinking, nextThinking);

    const patches = savedPatches();
    expect(patches).toHaveLength(2);
    const modelPatch = patches[0] ?? {};
    expect(modelPatch).toMatchObject({
      handoffSummaryModel: 'ollama-acme-private:latest',
    });
    expect(Object.keys(modelPatch).sort()).toEqual([
      'handoffSummaryModel',
      'handoffSummaryThinkingLevel',
    ]);
    expect(patches[1]).toEqual({ handoffSummaryThinkingLevel: nextThinking });
  });

  it('updates the mounted handoff row from Advisor without replacing persisted defaults', async () => {
    await renderChatTab();
    const titleModel = querySettingsSelect(
      requireRow('Chat title model'),
      'button[role="combobox"]',
    );
    if (!titleModel) throw new Error('title model select missing');
    const beforeTitle = titleModel.value;
    act(() => {
      emitPreferencesUpdated(
        makeTestPreferences({
          handoffSummaryModel: 'gpt-5.5',
          handoffSummaryThinkingLevel: 'high',
          summaryModel: 'gpt-5.5',
          defaultWorktreeModelByProvider: {
            claude: { model: 'haiku', thinkingLevel: 'off' },
            codex: { model: 'gpt-5.5', thinkingLevel: 'off' },
            ollama: null,
          },
        }),
      );
    });
    expect(requireSelect('settings-handoff-summary-model').value).toBe(
      'gpt-5.5',
    );
    expect(requireSelect('settings-handoff-summary-thinking').value).toBe(
      'high',
    );
    expect(titleModel.value).toBe(beforeTitle);
    expect(
      querySettingsSelect(
        container,
        '[data-testid="chat-defaults-row-claude"] button[role="combobox"]',
      )?.value,
    ).toBe('claude-retired-model');
    expect(savedPatches()).toHaveLength(0);
  });

  it('keeps title and worktree activity saves off the handoff keys', async () => {
    await renderChatTab();

    const handoffModel = requireSelect('settings-handoff-summary-model');
    const titleModel = querySettingsSelect(
      requireRow('Chat title model'),
      'button[role="combobox"]',
    );
    const activityModel = querySettingsSelect(
      requireRow('Worktree activity summary model'),
      'button[role="combobox"]',
    );
    if (!titleModel || !activityModel) throw new Error('model select missing');
    changeSelect(titleModel, 'gpt-5.5');
    changeSelect(activityModel, 'gpt-5.5');

    const patches = savedPatches();
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ summaryModel: 'gpt-5.5' });
    expect(patches[1]).toMatchObject({ worktreeSummaryModel: 'gpt-5.5' });
    for (const patch of patches) {
      expect(patch).not.toHaveProperty('handoffSummaryModel');
      expect(patch).not.toHaveProperty('handoffSummaryThinkingLevel');
    }
    expect(handoffModel.value).toBe('haiku');
  });

  describe('GPT-6.1 Sol Low in the default model groups', () => {
    const SOL = 'gpt-6.1-sol';
    const ASTRA = 'gpt-6-astra';
    const SOL_LEVELS: ThinkingLevel[] = [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ];
    const GROUPS = [
      {
        title: 'Default code model',
        key: 'defaultWorktreeModelByProvider',
        otherKey: 'defaultChatModelByProvider',
      },
      {
        title: 'Default chat model',
        key: 'defaultChatModelByProvider',
        otherKey: 'defaultWorktreeModelByProvider',
      },
    ] as const;

    function initCatalog({
      solLevels = SOL_LEVELS,
      includeSol = true,
    }: { solLevels?: ThinkingLevel[]; includeSol?: boolean } = {}): void {
      // Astra declares exactly Sol's levels, so a difference between the two
      // rows can only come from the model ID.
      initCodexModels([
        {
          id: ASTRA,
          label: 'GPT 6 Astra',
          supportedThinkingLevels: SOL_LEVELS,
        },
        ...(includeSol
          ? [
              {
                id: SOL,
                label: 'GPT 6.1 Sol',
                supportedThinkingLevels: solLevels,
              },
            ]
          : []),
      ]);
    }

    function setPreferences(overrides: Partial<PreferencesData>): void {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          loadPreferences: jest
            .fn()
            .mockResolvedValue(makeTestPreferences(overrides)),
          savePreferences: jest.fn().mockResolvedValue(undefined),
        },
      });
    }

    function codexDefaults(
      codex: ProviderModelSelection,
    ): ModelDefaultsByProvider {
      return {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
        codex,
        ollama: null,
        aiCredits: null,
      };
    }

    function groupPreferences(
      key: (typeof GROUPS)[number]['key'],
      defaults: ModelDefaultsByProvider,
    ): Partial<PreferencesData> {
      return key === 'defaultWorktreeModelByProvider'
        ? { defaultWorktreeModelByProvider: defaults }
        : { defaultChatModelByProvider: defaults };
    }

    function groupSelect(title: string, testId: string): SettingsSelectProbe {
      const heading = Array.from(container.querySelectorAll('h2')).find(
        (element) => element.textContent === title,
      );
      const section = heading?.closest('section');
      const select = section
        ? querySettingsSelect(section, `[data-testid="${testId}"]`)
        : null;
      if (!select) throw new Error(`${title} ${testId} select missing`);
      return select;
    }

    function optionValues(select: SettingsSelectProbe): string[] {
      return Array.from(select.options, (option) => option.value);
    }

    function optionLabels(select: SettingsSelectProbe): string[] {
      return Array.from(select.options, (option) => option.textContent ?? '');
    }

    function selectedLabel(select: SettingsSelectProbe): string | undefined {
      return select.trigger.textContent ?? undefined;
    }

    beforeEach(() => {
      initCatalog();
    });

    afterEach(() => {
      initAiGatewayModels([], []);
      resetGatewayCatalogHydrationForTests();
    });

    it.each(GROUPS)(
      'saves the displayed Medium when AI Credits in $title leaves Sol Low',
      async ({ title, key, otherKey }) => {
        // Exercise the renderer contract directly. The current package merge
        // reserves these native IDs, so this is not gateway-route evidence.
        const entries = [SOL, ASTRA].map((id) => ({
          id,
          label: id,
          recommendedHarness: 'codex' as const,
          family: 'openai',
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: SOL_LEVELS,
          toolSchemaProfile: 'standard' as const,
        }));
        initAiGatewayModels(
          entries,
          entries.map((entry) => ({
            ...entry,
            modelId: entry.id,
            gatewayId: `openai/${entry.id}`,
            gatewayOnly: false,
          })),
        );
        const defaults = codexDefaults({ model: SOL, thinkingLevel: 'high' });
        setPreferences({
          ...groupPreferences(key, defaults),
          ...groupPreferences(otherKey, defaults),
        });
        await renderChatTab();

        const model = groupSelect(title, 'chat-defaults-model-aiCredits');
        changeSelect(model, SOL);
        const thinking = groupSelect(title, 'chat-defaults-thinking-aiCredits');
        expect(optionValues(thinking)).toContain('low');
        changeSelect(thinking, 'low');
        expect(thinking.value).toBe('low');
        expect(savedPatches().at(-1)?.[key]).toMatchObject({
          aiCredits: { model: SOL, thinkingLevel: 'low' },
        });

        changeSelect(model, ASTRA);

        expect(thinking.value).toBe('medium');
        expect(selectedLabel(thinking)).toBe('Medium');
        expect(savedPatches().at(-1)?.[key]).toMatchObject({
          aiCredits: { model: ASTRA, thinkingLevel: 'medium' },
        });
        expect(savedPatches().at(-1)).not.toHaveProperty(otherKey);
      },
    );

    it.each(GROUPS)(
      'offers and saves Low for Sol in $title',
      async ({ title, key, otherKey }) => {
        setPreferences({
          defaultWorktreeModelByProvider: codexDefaults({
            model: SOL,
            thinkingLevel: 'medium',
          }),
          defaultChatModelByProvider: codexDefaults({
            model: SOL,
            thinkingLevel: 'medium',
          }),
        });
        await renderChatTab();

        const thinking = groupSelect(title, 'chat-defaults-thinking-codex');
        expect(optionLabels(thinking)).toEqual([
          'Low',
          'Medium',
          'High',
          'Extra High',
          'Max',
          'Ultra',
        ]);
        const values = optionValues(thinking);
        expect(values.indexOf('low')).toBe(values.indexOf('medium') - 1);

        changeSelect(thinking, 'low');

        const patches = savedPatches();
        expect(patches).toHaveLength(1);
        expect(patches[0]?.[key]).toMatchObject({
          codex: { model: SOL, thinkingLevel: 'low' },
        });
        expect(patches[0]).not.toHaveProperty(otherKey);
        expect(thinking.value).toBe('low');
        const otherTitle = GROUPS.find(
          (group) => group.key === otherKey,
        )?.title;
        if (!otherTitle) throw new Error('other group missing');
        expect(
          groupSelect(otherTitle, 'chat-defaults-thinking-codex').value,
        ).toBe('medium');
      },
    );

    it('displays a saved Sol Low in both groups without saving', async () => {
      setPreferences({
        defaultWorktreeModelByProvider: codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        }),
        defaultChatModelByProvider: codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        }),
      });
      await renderChatTab();

      for (const { title } of GROUPS) {
        const thinking = groupSelect(title, 'chat-defaults-thinking-codex');
        expect(thinking.value).toBe('low');
        expect(selectedLabel(thinking)).toBe('Low');
      }
      expect(savedPatches()).toHaveLength(0);
    });

    it.each(GROUPS)(
      'saves the displayed Medium when $title switches from Sol Low to Astra',
      async ({ title, key, otherKey }) => {
        const savedDefault = codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        });
        setPreferences({
          ...groupPreferences(key, savedDefault),
          ...groupPreferences(otherKey, savedDefault),
        });
        await renderChatTab();

        const otherTitle = GROUPS.find(
          (group) => group.key === otherKey,
        )?.title;
        if (!otherTitle) throw new Error('other group missing');
        const otherModel = groupSelect(otherTitle, 'chat-defaults-model-codex');
        const otherThinking = groupSelect(
          otherTitle,
          'chat-defaults-thinking-codex',
        );
        expect(otherModel.value).toBe(SOL);
        expect(otherThinking.value).toBe('low');
        expect(selectedLabel(otherThinking)).toBe('Low');

        changeSelect(groupSelect(title, 'chat-defaults-model-codex'), ASTRA);

        const patches = savedPatches();
        expect(patches).toHaveLength(1);
        expect(patches[0]?.[key]).toMatchObject({
          codex: { model: ASTRA, thinkingLevel: 'medium' },
        });
        expect(patches[0]).not.toHaveProperty(otherKey);
        expect(otherModel.value).toBe(SOL);
        expect(otherThinking.value).toBe('low');
        expect(selectedLabel(otherThinking)).toBe('Low');
        const thinking = groupSelect(title, 'chat-defaults-thinking-codex');
        expect(thinking.value).toBe('medium');
        expect(optionValues(thinking)).not.toContain('low');
      },
    );

    it('does not offer Low for Astra with the same declared levels', async () => {
      setPreferences({
        defaultWorktreeModelByProvider: codexDefaults({
          model: ASTRA,
          thinkingLevel: 'low',
        }),
      });
      await renderChatTab();

      const thinking = groupSelect(
        'Default code model',
        'chat-defaults-thinking-codex',
      );
      expect(optionLabels(thinking)).toEqual([
        'Medium',
        'High',
        'Extra High',
        'Max',
        'Ultra',
      ]);
      expect(thinking.value).toBe('medium');
      expect(savedPatches()).toHaveLength(0);
    });

    it('does not offer Low when Sol does not declare it', async () => {
      initCatalog({ solLevels: ['medium', 'high', 'xhigh', 'max', 'ultra'] });
      setPreferences({
        defaultWorktreeModelByProvider: codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        }),
      });
      await renderChatTab();

      const thinking = groupSelect(
        'Default code model',
        'chat-defaults-thinking-codex',
      );
      expect(optionValues(thinking)).not.toContain('low');
      expect(thinking.value).toBe('medium');
      expect(savedPatches()).toHaveLength(0);
    });

    it('keeps an unavailable saved Sol Low disabled without a Low option', async () => {
      initCatalog({ includeSol: false });
      setPreferences({
        defaultWorktreeModelByProvider: codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        }),
      });
      await renderChatTab();

      expect(
        selectedLabel(
          groupSelect('Default code model', 'chat-defaults-model-codex'),
        ),
      ).toBe(`${SOL} (unavailable)`);
      const thinking = groupSelect(
        'Default code model',
        'chat-defaults-thinking-codex',
      );
      expect(thinking.disabled).toBe(true);
      expect(thinking.value).toBe('low');
      // A disabled dropdown cannot open; it shows the saved value as is.
      expect(selectedLabel(thinking)).not.toBe('Low');
      expect(savedPatches()).toHaveLength(0);
    });

    it('does not offer Low for the AI Credits Automatic selection', async () => {
      setPreferences({
        defaultWorktreeModelByProvider: codexDefaults({
          model: SOL,
          thinkingLevel: 'low',
        }),
      });
      await renderChatTab();

      expect(
        groupSelect('Default code model', 'chat-defaults-model-aiCredits')
          .value,
      ).toBe('');
      const thinking = groupSelect(
        'Default code model',
        'chat-defaults-thinking-aiCredits',
      );
      expect(thinking.disabled).toBe(true);
      expect(thinking.value).not.toBe('low');
      expect(savedPatches()).toHaveLength(0);
    });
  });
});
