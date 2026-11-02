/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chooseSettingsOptionSync,
  settingsSelectGroupLabels,
  settingsSelectOption,
  settingsSelectOptionValues,
  settingsSelectTrigger,
  settingsSelectValue,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
import {
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initOllamaModels,
  type OllamaModelEntry,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { ModelThinkingPreferenceRow } from '../ModelThinkingPreferenceRow';

let mockCursorAvailable = false;
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (enabled: boolean): boolean =>
    enabled && mockCursorAvailable,
}));
jest.mock('@/hooks/useCursorModels', () => ({
  useCursorModels: (): {
    models: { id: string; rawModelId: string; label: string }[];
    message: undefined;
  } => ({
    models: [
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
      {
        id: 'cursor:gpt-6-luna',
        rawModelId: 'gpt-6-luna',
        label: 'GPT-6 Luna',
      },
    ],
    message: undefined,
  }),
}));

const SUPPORTED_OLLAMA_ENTRY: OllamaModelEntry = {
  id: 'ollama-llama3:8b',
  rawModelId: 'llama3:8b',
  label: 'Llama 3 8B',
  show: { capabilities: ['completion', 'tools'] },
};

const mounted: { host: HTMLElement; root: Root }[] = [];

afterEach(() => {
  for (const { host, root } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

/** Mounts the row and returns its host element. */
function mountRow(
  model = 'claude-sonnet-4-6',
  thinkingLevel: ThinkingLevel = 'off',
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  act(() => {
    root.render(
      <ModelThinkingPreferenceRow
        title="Branch naming model"
        description="Model used to generate branch names"
        model={model}
        thinkingLevel={thinkingLevel}
        defaultThinkingLevel="off"
        onModelChange={() => undefined}
        onThinkingChange={() => undefined}
        testIdPrefix="branch-naming"
      />,
    );
  });
  return host;
}

function modelGroups(host: HTMLElement, prefix = 'branch-naming'): string[] {
  return settingsSelectGroupLabels(
    settingsSelectTrigger(host, `[data-testid="${prefix}-model"]`),
  );
}

describe('ModelThinkingPreferenceRow — Ollama catalog gating', () => {
  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  });

  afterEach(() => {
    initOllamaModels([]);
  });

  it('omits the Ollama group when the catalog is empty (disabled build)', () => {
    initOllamaModels([]);
    const groups = modelGroups(mountRow());
    expect(groups).toContain('Claude');
    expect(groups).not.toContain('Ollama');
  });

  it('shows the Ollama group when models are available (macOS)', () => {
    initOllamaModels([SUPPORTED_OLLAMA_ENTRY]);
    expect(modelGroups(mountRow())).toContain('Ollama');
  });

  it('keeps the thinking test id on the dropdown trigger', () => {
    const host = mountRow();
    expect(
      settingsSelectTrigger(host, '[data-testid="branch-naming-thinking"]'),
    ).toBeTruthy();
  });

  it('uses the shared capsule dropdown in two equal 144px columns', () => {
    const host = mountRow();
    const triggers = host.querySelectorAll<HTMLButtonElement>(
      'button[role="combobox"]',
    );
    expect(triggers).toHaveLength(2);
    triggers.forEach((trigger: HTMLButtonElement) => {
      expect(trigger.classList.contains('rounded-full')).toBe(true);
      expect(trigger.classList.contains('h-7')).toBe(true);
    });
    expect(host.querySelectorAll('.w-36')).toHaveLength(2);
  });

  it('shows the saved model while unavailable and restores its catalog label', () => {
    const unavailableHost = mountRow('gpt-future-summary', 'ultra');
    const unavailable = settingsSelectTrigger(
      unavailableHost,
      '[data-testid="branch-naming-model"]',
    );
    expect(settingsSelectValue(unavailable)).toBe('gpt-future-summary');
    expect(unavailable.textContent).toBe('gpt-future-summary (unavailable)');
    expect(settingsSelectOption(unavailable, 'gpt-future-summary')).toEqual({
      label: 'gpt-future-summary (unavailable)',
      disabled: true,
    });
    expect(
      settingsSelectValue(
        settingsSelectTrigger(
          unavailableHost,
          '[data-testid="branch-naming-thinking"]',
        ),
      ),
    ).toBe('ultra');

    initCodexModels([{ id: 'gpt-future-summary', label: 'Future summary' }]);
    const restored = settingsSelectTrigger(
      mountRow('gpt-future-summary'),
      '[data-testid="branch-naming-model"]',
    );
    expect(settingsSelectValue(restored)).toBe('gpt-future-summary');
    expect(restored.textContent).toBe('Future summary');
    expect(settingsSelectOption(restored, 'gpt-future-summary')).toEqual({
      label: 'Future summary',
      disabled: false,
    });
  });

  it('labels a saved model id the registries no longer list as unavailable', () => {
    const trigger = settingsSelectTrigger(
      mountRow('ollama-my-private-model'),
      '[data-testid="branch-naming-model"]',
    );
    expect(
      settingsSelectOption(trigger, 'ollama-my-private-model')?.label,
    ).toBe('ollama-my-private-model (unavailable)');
  });
});

describe('ModelThinkingPreferenceRow — Cursor opt-in', () => {
  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
      {
        id: 'cursor:gpt-6-luna',
        rawModelId: 'gpt-6-luna',
        label: 'GPT-6 Luna',
      },
    ]);
    mockCursorAvailable = true;
  });
  afterEach(() => {
    initCursorModels([]);
    mockCursorAvailable = false;
  });
  const render = (model: string, includeCursor: boolean): string =>
    renderToStaticMarkup(
      <ModelThinkingPreferenceRow
        title="Default model"
        description="App Advisor"
        model={model}
        thinkingLevel="high"
        defaultThinkingLevel="high"
        onModelChange={() => undefined}
        onThinkingChange={() => undefined}
        testIdPrefix="advisor"
        includeCursor={includeCursor}
      />,
    );
  const mount = (model: string, includeCursor: boolean): HTMLElement => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ host, root });
    act(() => {
      root.render(
        <ModelThinkingPreferenceRow
          title="Default model"
          description="App Advisor"
          model={model}
          thinkingLevel="high"
          defaultThinkingLevel="high"
          onModelChange={() => undefined}
          onThinkingChange={() => undefined}
          testIdPrefix="advisor"
          includeCursor={includeCursor}
        />,
      );
    });
    return host;
  };
  it('omits the Cursor group unless the caller opts in', () => {
    expect(modelGroups(mount('gpt-5.5', false), 'advisor')).not.toContain(
      'Cursor',
    );
  });
  it('lists cached Cursor models when opted in and available', () => {
    const host = mount('gpt-5.5', true);
    expect(modelGroups(host, 'advisor')).toContain('Cursor');
    const values = settingsSelectOptionValues(
      settingsSelectTrigger(host, '[data-testid="advisor-model"]'),
    );
    expect(values).toContain('cursor-default');
    expect(values).toContain('cursor:gpt-6-luna');
  });
  it('omits the Cursor group while the runtime is unavailable', () => {
    mockCursorAvailable = false;
    expect(modelGroups(mount('gpt-5.5', true), 'advisor')).not.toContain(
      'Cursor',
    );
  });
  it('hides the thinking select for a Cursor model and keeps it for others', () => {
    expect(render('cursor-default', true)).not.toMatch(
      /data-testid="advisor-thinking"/,
    );
    expect(render('gpt-5.5', true)).toMatch(/data-testid="advisor-thinking"/);
  });
  it('keeps the saved thinking level when the user picks a Cursor model', () => {
    const onModelChange = jest.fn<void, [string, ThinkingLevel]>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          createElement(ModelThinkingPreferenceRow, {
            title: 'Default model',
            description: 'App Advisor',
            model: 'gpt-5.5',
            thinkingLevel: 'xhigh',
            defaultThinkingLevel: 'high',
            onModelChange,
            onThinkingChange: () => undefined,
            testIdPrefix: 'advisor',
            includeCursor: true,
          }),
        );
      });
      chooseSettingsOptionSync(
        settingsSelectTrigger(host, '[data-testid="advisor-model"]'),
        'cursor-default',
      );
      // Cursor has no thinking level to clamp into; the saved level is left
      // untouched so a later switch back to Claude or Codex keeps it.
      expect(onModelChange).toHaveBeenCalledWith('cursor-default', 'xhigh');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('shows a saved Cursor id as unavailable once the runtime is gone', () => {
    mockCursorAvailable = false;
    const html = render('cursor-default', true);
    expect(html).toContain('cursor-default (unavailable)');
    // Cursor never has a thinking level, connected or not.
    expect(html).not.toMatch(/data-testid="advisor-thinking"/);
  });
});
