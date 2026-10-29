/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { ProviderAvailability } from '@/hooks/useProviderAvailability';
import type { AiCreditsAvailability } from '@/hooks/useAiCreditsAvailability';
import { makeTestPreferences } from '@/test-utils/preferences';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { ChatTab } from '../ChatTab';

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

    const codeDefaults = container.querySelector(
      '[data-testid="chat-defaults-row-ollama"]',
    );
    const ollamaOption = codeDefaults?.querySelector(
      'option[value="ollama-acme-private:latest"]',
    );
    expect(ollamaOption).not.toBeNull();

    const claudeRow = container.querySelector(
      '[data-testid="chat-defaults-row-claude"]',
    );
    const retired = claudeRow?.querySelector(
      'option[value="claude-retired-model"]',
    );
    expect(retired?.textContent).toBe('claude-retired-model (unavailable)');
  });

  async function renderChatTab(): Promise<void> {
    await act(async () => {
      root.render(<ChatTab />);
      await Promise.resolve();
    });
  }

  function requireSelect(testId: string): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>(
      `select[data-testid="${testId}"]`,
    );
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

  function changeSelect(select: HTMLSelectElement, value: string): void {
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
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
      handoffModel.querySelector('option[value="ollama-acme-private:latest"]'),
    ).not.toBeNull();
    const groups = Array.from(handoffModel.querySelectorAll('optgroup')).map(
      (group) => group.label,
    );
    expect(groups).toEqual(['Claude', 'Codex', 'Ollama']);
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
    const titleModel = requireRow('Chat title model').querySelector('select');
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
      container.querySelector<HTMLSelectElement>(
        '[data-testid="chat-defaults-row-claude"] select',
      )?.value,
    ).toBe('claude-retired-model');
    expect(savedPatches()).toHaveLength(0);
  });

  it('keeps title and worktree activity saves off the handoff keys', async () => {
    await renderChatTab();

    const handoffModel = requireSelect('settings-handoff-summary-model');
    const titleModel = requireRow('Chat title model').querySelector('select');
    const activityModel = requireRow(
      'Worktree activity summary model',
    ).querySelector('select');
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
});
