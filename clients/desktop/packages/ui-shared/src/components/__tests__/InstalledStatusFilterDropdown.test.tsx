/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstalledStatusFilterDropdown } from '../InstalledStatusFilterDropdown';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const activeRoots: Root[] = [];

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
  return root;
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`${id} not found`);
  return element;
}

function queryTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

afterEach(() => {
  for (const root of activeRoots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('InstalledStatusFilterDropdown (CAN-4838)', () => {
  it('lists Any status and every status with its icon, marks the selection and reports changes', () => {
    const onChange = jest.fn();
    render(
      <InstalledStatusFilterDropdown value="active" onChange={onChange} />,
    );
    const trigger = byTestId('customize-installed-status-filter');
    expect(trigger.getAttribute('data-status')).toBe('active');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Filter installed items by status: Active',
    );
    expect(trigger.querySelector('[data-status-dot="active"]')).not.toBeNull();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = byTestId('customize-installed-status-filter-menu');
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    expect(
      byTestId('customize-installed-status-filter-option-any').textContent,
    ).toBe('Any status');
    expect(
      byTestId('customize-installed-status-filter-option-active').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    const disabled = byTestId(
      'customize-installed-status-filter-option-disabled',
    );
    expect(
      disabled.querySelector('[data-status-dot="disabled"]'),
    ).not.toBeNull();
    expect(disabled.textContent).toContain('Installed, but turned off');
    act(() => byTestId('customize-installed-status-filter-option-any').click());
    expect(onChange).toHaveBeenCalledWith(null);
    expect(queryTestId('customize-installed-status-filter-menu')).toBeNull();
  });

  it('shows Any status without a dot when nothing is selected', () => {
    render(<InstalledStatusFilterDropdown value={null} onChange={() => {}} />);
    const trigger = byTestId('customize-installed-status-filter');
    expect(trigger.getAttribute('data-status')).toBe('any');
    expect(trigger.querySelector('[data-status-dot]')).toBeNull();
    expect(trigger.textContent).toContain('Any status');
  });

  it('closes on Escape without reporting a change', () => {
    const onChange = jest.fn();
    render(
      <InstalledStatusFilterDropdown value="disabled" onChange={onChange} />,
    );
    act(() => byTestId('customize-installed-status-filter').click());
    act(() => {
      byTestId('customize-installed-status-filter-menu').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(queryTestId('customize-installed-status-filter-menu')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
