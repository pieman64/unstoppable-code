/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/lib/theme', () => ({ applyTheme: jest.fn() }));

import { FieldsLabPage } from '../FieldsLabPage';

describe('FieldsLabPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(search: string): void {
    window.history.replaceState(null, '', `/fields-lab.html${search}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<FieldsLabPage />));
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => (element.textContent ?? '').trim() === text,
    );
    if (!button) throw new Error(`No button ${text}`);
    return button;
  }

  it('shows the field errors after an empty submit in the playground', () => {
    mount('');
    expect(container.textContent).not.toContain('Enter an organization name.');
    act(() => buttonByText('Save').click());
    expect(container.textContent).toContain('Enter an organization name.');
    expect(container.textContent).toContain('Choose an environment.');
    const name = container.querySelector<HTMLInputElement>(
      'input[placeholder="Acme Engineering"]',
    );
    expect(name?.getAttribute('aria-invalid')).toBe('true');
  });

  it('draws one row per component with a cell for every state', () => {
    mount('?view=states');
    const cells = container.querySelectorAll('[data-row="text-settings"]');
    expect(
      Array.from(cells).map((cell) => cell.getAttribute('data-state')),
    ).toEqual([
      'Empty, placeholder',
      'Filled',
      'Long value',
      'Focused',
      'Disabled',
      'Read-only',
      'Invalid + error',
      'Help text',
      'Error + help',
      'Leading / trailing',
    ]);
    // The focused cell holds real browser focus.
    const focused = container.querySelector(
      '[data-row="text-default"][data-state="Focused"] input',
    );
    expect(document.activeElement).toBe(focused);
  });

  it('disables every playground field from the header', () => {
    mount('');
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="All disabled"]',
    );
    act(() => toggle?.click());
    const name = container.querySelector<HTMLInputElement>(
      'input[placeholder="Acme Engineering"]',
    );
    expect(name?.disabled).toBe(true);
  });
});
