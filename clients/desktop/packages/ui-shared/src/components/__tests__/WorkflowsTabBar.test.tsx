/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowsTabBar } from '../WorkflowsTabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('WorkflowsTabBar', () => {
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
  });

  function tab(id: string): HTMLButtonElement {
    const element = container.querySelector(
      `[data-testid="workflows-tab-${id}"]`,
    );
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing tab ${id}`);
    }
    return element;
  }

  it('renders the three tabs in order with only the selected one tabbable', () => {
    act(() => {
      root.render(
        <WorkflowsTabBar value="workflows-schedule" onChange={jest.fn()} />,
      );
    });

    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Workflows');
    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['Runs', 'Schedule', 'Library']);
    expect(tab('workflows-schedule').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(tab('workflows-schedule').tabIndex).toBe(0);
    expect(tab('workflows').getAttribute('aria-selected')).toBe('false');
    expect(tab('workflows').tabIndex).toBe(-1);
    expect(tab('workflows-library').tabIndex).toBe(-1);
  });

  it('ties every tab to the panel it controls', () => {
    act(() => {
      root.render(
        <WorkflowsTabBar value="workflows-library" onChange={jest.fn()} />,
      );
    });

    for (const id of ['workflows', 'workflows-schedule', 'workflows-library']) {
      expect(tab(id).id).toBe(`workflows-tab-${id}`);
      expect(tab(id).getAttribute('aria-controls')).toBe('workflows-tab-panel');
    }
  });

  it('reports a clicked tab', () => {
    const onChange = jest.fn();
    act(() => {
      root.render(<WorkflowsTabBar value="workflows" onChange={onChange} />);
    });

    act(() => tab('workflows-library').click());

    expect(onChange).toHaveBeenCalledWith('workflows-library', 'pointer');
  });

  it.each([
    ['ArrowRight', 'workflows', 'workflows-schedule'],
    ['ArrowRight', 'workflows-library', 'workflows'],
    ['ArrowLeft', 'workflows', 'workflows-library'],
    ['Home', 'workflows-library', 'workflows'],
    ['End', 'workflows', 'workflows-library'],
  ] as const)('%s from %s selects and focuses %s', (key, from, to) => {
    const onChange = jest.fn();
    act(() => {
      root.render(<WorkflowsTabBar value={from} onChange={onChange} />);
    });

    act(() => {
      tab(from).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });

    expect(onChange).toHaveBeenCalledWith(to, 'keyboard');
    expect(document.activeElement).toBe(tab(to));
  });

  it.each([true, false])(
    'focuses the selected tab on mount only when asked (%s)',
    (focusSelectedOnMount) => {
      act(() => {
        root.render(
          <WorkflowsTabBar
            value="workflows-schedule"
            onChange={jest.fn()}
            focusSelectedOnMount={focusSelectedOnMount}
          />,
        );
      });

      expect(document.activeElement === tab('workflows-schedule')).toBe(
        focusSelectedOnMount,
      );
    },
  );

  it('ignores other keys', () => {
    const onChange = jest.fn();
    act(() => {
      root.render(<WorkflowsTabBar value="workflows" onChange={onChange} />);
    });

    act(() => {
      tab('workflows').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      );
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a count beside a tab, and none for zero or a tab without one', () => {
    act(() => {
      root.render(
        <WorkflowsTabBar
          value="workflows"
          onChange={jest.fn()}
          counts={{ workflows: 14, 'workflows-schedule': 0 }}
        />,
      );
    });

    const count = (id: string): string | null =>
      container.querySelector(`[data-testid="workflows-tab-count-${id}"]`)
        ?.textContent ?? null;
    expect(count('workflows')).toBe('14');
    expect(count('workflows-schedule')).toBeNull();
    expect(count('workflows-library')).toBeNull();
    expect(tab('workflows').textContent).toContain('Runs');
  });
});
