/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DetailMoreMenu } from '../DetailMoreMenu';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('DetailMoreMenu', () => {
  it('shows an item icon before its label, hidden from assistive tech', () => {
    act(() =>
      root.render(
        <DetailMoreMenu
          name="Code Reviewer"
          triggerTestId="more"
          menuTestId="menu"
          items={[
            {
              id: 'check',
              icon: <svg data-testid="check-glyph" />,
              label: 'Check for updates',
              testId: 'menu-check',
              onSelect: (): undefined => undefined,
            },
            {
              id: 'unshare',
              label: 'Unshare',
              testId: 'menu-unshare',
              icon: <svg data-testid="unshare-glyph" />,
              onSelect: (): undefined => undefined,
              destructive: true,
            },
          ]}
        />,
      ),
    );
    act(() => byTestId('more')?.click());
    const unshare = byTestId('menu-unshare');
    expect(unshare?.textContent).toBe('Unshare');
    const glyph = unshare?.querySelector('[data-testid="unshare-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    // Both rows retain develop's aligned icon slots and quiet menu styling.
    expect(byTestId('check-glyph')).not.toBeNull();
    expect(byTestId('menu-check')?.className).toContain('text-xs');
    expect(unshare?.className).toContain('text-xs');
  });
});
