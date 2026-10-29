/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelProviderIcon } from '../ModelProviderIcon';

function render(provider: string, central = false): HTMLDivElement {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <ModelProviderIcon provider={provider} central={central} size={12} />,
    ),
  );
  return container;
}

describe('ModelProviderIcon', () => {
  it.each(['opencode', 'org-gateway:acme'])(
    'keeps a %s Lucide glyph at an exact 12px when asked',
    (provider) => {
      const container = document.createElement('div');
      const root = createRoot(container);
      act(() =>
        root.render(
          <ModelProviderIcon provider={provider} central size={12} exactSize />,
        ),
      );
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('12px');
      expect(svg?.getAttribute('data-icon-size')).toBe('exact');
      act(() => root.unmount());
    },
  );

  it('draws a building, not an initial, for an organization group', () => {
    const icon = render('org-gateway:acme');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon.querySelector('[data-generic-provider-icon]')).toBeNull();
    expect(icon.textContent).toBe('');
  });

  it.each([false, true])(
    'uses the GitHub mark for Copilot (central=%s)',
    (central) => {
      const icon = render('copilot', central);
      expect(
        icon.querySelector(
          'svg[data-app-icon="true"][data-glyph="mark-github"]',
        ),
      ).not.toBeNull();
    },
  );

  it('keeps the initial fallback for an unknown vendor', () => {
    const icon = render('acme');
    expect(icon.querySelector('[data-generic-provider-icon]')).not.toBeNull();
    expect(icon.textContent).toBe('A');
  });
});
