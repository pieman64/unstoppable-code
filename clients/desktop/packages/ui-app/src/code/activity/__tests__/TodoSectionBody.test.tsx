/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TodoSectionBody, type TodoSectionBodyItem } from '../TodoSectionBody';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ITEMS: readonly TodoSectionBodyItem[] = [
  { id: 'pending', content: 'Pending task', status: 'pending' },
  { id: 'completed', content: 'Completed task', status: 'completed' },
  { id: 'active', content: 'Active task', status: 'in_progress' },
];

describe('TodoSectionBody', () => {
  it('orders active before pending and collapses completed items', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<TodoSectionBody items={ITEMS} resetKey="tab-a" />);
    });

    const rows = container.querySelectorAll(
      '[data-testid="activity-todo-item"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('Active task');
    expect(rows[1].textContent).toBe('Pending task');
    expect(
      container.querySelector('[data-testid="activity-todo-body"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('resets the completed disclosure when resetKey changes', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<TodoSectionBody items={ITEMS} resetKey="tab-a" />);
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-todo-completed-toggle"]',
    );
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Completed task');

    act(() => {
      root.render(<TodoSectionBody items={ITEMS} resetKey="tab-b" />);
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Completed task');

    act(() => root.unmount());
    container.remove();
  });
});
