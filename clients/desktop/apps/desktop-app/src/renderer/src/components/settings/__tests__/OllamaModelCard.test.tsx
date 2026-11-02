/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { OllamaModelEntry } from '@canopy/desktop-shared/types';
import { OllamaModelCard } from '../OllamaTab';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MODEL: OllamaModelEntry = {
  id: 'ollama-llama3:8b',
  rawModelId: 'llama3:8b',
  label: 'llama3:8b',
  details: { family: 'llama', parameterSize: '8B' },
  show: {
    capabilities: ['completion'],
    messages: [{ role: 'system', content: 'Answer directly.' }],
    rawJson: '{"model":"llama3:8b"}',
  },
};

describe('OllamaModelCard', () => {
  it('is a settings row whose facts open behind the shared Details disclosure', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <OllamaModelCard
          model={MODEL}
          deleting={false}
          onDelete={(): void => undefined}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="ollama-model-details-llama3:8b-toggle"]',
    );
    expect(toggle?.textContent).toBe('Details');
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain('Family: llama');
    act(() => toggle?.click());
    const body = container.querySelector(
      '[data-testid="ollama-model-details-llama3:8b-body"]',
    );
    expect(body?.textContent).toContain('Family: llama');
    expect(body?.textContent).toContain('Seed messages');
    expect(body?.textContent).toContain('Raw show() response');
    act(() => root.unmount());
    container.remove();
  });
});
