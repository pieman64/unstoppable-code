/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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

function renderRow(
  model = 'claude-sonnet-4-6',
  thinkingLevel: ThinkingLevel = 'off',
): string {
  return renderToStaticMarkup(
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
}

describe('ModelThinkingPreferenceRow — Ollama catalog gating', () => {
  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  });

  afterEach(() => {
    initOllamaModels([]);
  });

  it('omits the Ollama optgroup when the catalog is empty (disabled build)', () => {
    initOllamaModels([]);
    const html = renderRow();
    expect(html).toContain('label="Claude"');
    expect(html).not.toContain('label="Ollama"');
  });

  it('shows the Ollama optgroup when models are available (macOS)', () => {
    initOllamaModels([SUPPORTED_OLLAMA_ENTRY]);
    const html = renderRow();
    expect(html).toContain('label="Ollama"');
  });

  it('keeps the thinking test id on the select element', () => {
    const html = renderRow();
    expect(html).toMatch(
      /<select[^>]*data-testid="branch-naming-thinking"[^>]*>/,
    );
  });

  it('uses matching capsule geometry and equal columns for model and thinking', () => {
    const host = document.createElement('div');
    host.innerHTML = renderRow();
    const selects = host.querySelectorAll<HTMLSelectElement>('select');
    expect(selects).toHaveLength(2);
    selects.forEach((select: HTMLSelectElement) => {
      expect(select.classList.contains('rounded-full')).toBe(true);
      expect(select.classList.contains('rounded-md')).toBe(false);
    });
    expect(host.querySelectorAll('.w-36')).toHaveLength(2);
  });

  it('shows the saved model while unavailable and restores its catalog label', () => {
    const select = document.createElement('div');
    select.innerHTML = renderRow('gpt-future-summary', 'ultra');
    const unavailable = select.querySelector<HTMLSelectElement>(
      '[data-testid="branch-naming-model"]',
    );
    expect(unavailable?.value).toBe('gpt-future-summary');
    expect(unavailable?.selectedOptions[0]?.textContent).toBe(
      'gpt-future-summary (unavailable)',
    );
    expect(unavailable?.selectedOptions[0]?.disabled).toBe(true);
    expect(
      select.querySelector<HTMLSelectElement>(
        '[data-testid="branch-naming-thinking"]',
      )?.value,
    ).toBe('ultra');

    initCodexModels([{ id: 'gpt-future-summary', label: 'Future summary' }]);
    select.innerHTML = renderRow('gpt-future-summary');
    const restored = select.querySelector<HTMLSelectElement>(
      '[data-testid="branch-naming-model"]',
    );
    expect(restored?.value).toBe('gpt-future-summary');
    expect(restored?.selectedOptions[0]?.textContent).toBe('Future summary');
    expect(restored?.selectedOptions[0]?.disabled).toBe(false);
  });

  it('labels a saved model id the registries no longer list as unavailable', () => {
    const host = document.createElement('div');
    host.innerHTML = renderRow('ollama-my-private-model');
    const option = host.querySelector(
      'option[value="ollama-my-private-model"]',
    );
    expect(option?.textContent).toBe('ollama-my-private-model (unavailable)');
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
  it('omits the Cursor optgroup unless the caller opts in', () => {
    expect(render('gpt-5.5', false)).not.toContain('label="Cursor"');
  });
  it('lists cached Cursor models when opted in and available', () => {
    const html = render('gpt-5.5', true);
    expect(html).toContain('label="Cursor"');
    expect(html).toContain('value="cursor-default"');
    expect(html).toContain('value="cursor:gpt-6-luna"');
  });
  it('omits the Cursor optgroup while the runtime is unavailable', () => {
    mockCursorAvailable = false;
    expect(render('gpt-5.5', true)).not.toContain('label="Cursor"');
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
      const select = host.querySelector<HTMLSelectElement>(
        '[data-testid="advisor-model"]',
      );
      if (!select) throw new Error('model select missing');
      act(() => {
        select.value = 'cursor-default';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
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
