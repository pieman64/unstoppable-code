/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginConnectionRouteSection } from '../PluginConnectionRouteSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('PluginConnectionRouteSection', () => {
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

  function render(): HTMLElement {
    act(() => {
      root.render(
        <PluginConnectionRouteSection
          title="Provider connections"
          description="Connects through your Claude or Codex account."
          dataTestId="route"
        >
          <p data-testid="route-body">Claude</p>
        </PluginConnectionRouteSection>,
      );
    });
    const section = container.querySelector('[data-testid="route"]');
    if (!(section instanceof HTMLElement)) throw new Error('Missing section');
    return section;
  }

  it('names the route as a labelled section above its own controls', () => {
    const section = render();
    expect(section.tagName).toBe('SECTION');
    const heading = section.querySelector('h3');
    expect(heading?.textContent).toBe('Provider connections');
    expect(heading?.id).not.toBe('');
    expect(section.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(section.textContent).toContain(
      'Connects through your Claude or Codex account.',
    );
    expect(
      section.querySelector('[data-testid="route-body"]')?.textContent,
    ).toBe('Claude');
  });

  it('separates routes with a divider rather than another card', () => {
    const section = render();
    expect(section.className).toContain('border-t');
    expect(section.className).not.toContain('rounded');
    expect(section.className).not.toContain('ring-');
  });

  it('gives every route body the same measure so consecutive routes align', () => {
    const section = render();
    const body = section.querySelector(
      '[data-testid="route-body"]',
    )?.parentElement;
    expect(body?.className).toContain('max-w-2xl');
    // The divider itself still spans the detail.
    expect(section.className).not.toContain('max-w-');
  });
});
