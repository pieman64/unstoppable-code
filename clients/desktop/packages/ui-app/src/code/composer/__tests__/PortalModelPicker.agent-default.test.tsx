/**
 * @jest-environment jsdom
 */
/**
 * A chat on an Agent that inherits the default stores a route id
 * (`agent_model_x@<base>`); the portal picker must select that Agent's row.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelCatalog } from '@canopy/ui-shared';
import { PortalModelPicker } from '../PortalModelPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const catalog: ModelCatalog = [
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    provider: 'codex',
    source: 'codex',
    kind: 'model',
    available: true,
  },
  {
    id: 'agent_model_inherit',
    label: 'Inherit',
    provider: 'codex',
    harness: 'codex',
    kind: 'agent',
    available: true,
  },
];

describe('PortalModelPicker with an Agent route', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function option(id: string): Element | undefined {
    return Array.from(
      document.querySelectorAll('[data-testid="portal-chat-model-option"]'),
    ).find((el) => el.getAttribute('data-model-id') === id);
  }

  it('selects the Agent row for its route id', () => {
    act(() => {
      root.render(
        <PortalModelPicker
          catalog={catalog}
          currentModel="agent_model_inherit@gpt-5.5"
          onSelect={() => {}}
        />,
      );
    });
    const trigger = container.querySelector(
      '[data-testid="portal-chat-model-picker"]',
    );
    expect(trigger?.textContent).toContain('Inherit');

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(option('agent_model_inherit')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(option('gpt-5.5')?.getAttribute('aria-checked')).toBe('false');
  });
});
