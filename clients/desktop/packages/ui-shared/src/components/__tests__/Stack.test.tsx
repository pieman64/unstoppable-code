/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Inline, SPACE_ROLE_GAP_CLASS, Stack } from '../Stack';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function render(node: ReactNode): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function classesOf(element: Element | null): string[] {
  return (element?.getAttribute('class') ?? '').split(' ');
}

describe('spacing roles', () => {
  it('map onto the eight gap steps of the scale', () => {
    expect(SPACE_ROLE_GAP_CLASS).toEqual({
      tight: 'gap-1',
      inline: 'gap-2',
      item: 'gap-3',
      group: 'gap-4',
      block: 'gap-5',
      section: 'gap-6',
      page: 'gap-8',
      hero: 'gap-10',
    });
  });
});

describe('Stack', () => {
  it('owns the spacing between its children with one gap', () => {
    const { container, cleanup } = render(
      <Stack gap="section" data-testid="stack">
        <p>One</p>
        <p>Two</p>
      </Stack>,
    );
    const stack = container.querySelector('[data-testid="stack"]');
    expect(stack?.tagName).toBe('DIV');
    expect(classesOf(stack)).toEqual(['flex', 'flex-col', 'gap-6']);
    expect(stack?.children).toHaveLength(2);
    cleanup();
  });

  it('renders the requested element, alignment, and placement', () => {
    const { container, cleanup } = render(
      <Stack
        as="ul"
        gap="tight"
        align="start"
        className="min-w-0 flex-1"
        aria-label="Steps"
      >
        <li>One</li>
      </Stack>,
    );
    const list = container.querySelector('ul');
    expect(list?.getAttribute('aria-label')).toBe('Steps');
    expect(classesOf(list)).toEqual([
      'flex',
      'flex-col',
      'gap-1',
      'items-start',
      'min-w-0',
      'flex-1',
    ]);
    cleanup();
  });
});

describe('Inline', () => {
  it('defaults to a centered row 8px apart', () => {
    const { container, cleanup } = render(
      <Inline data-testid="row">
        <span>A</span>
        <span>B</span>
      </Inline>,
    );
    expect(classesOf(container.querySelector('[data-testid="row"]'))).toEqual([
      'flex',
      'gap-2',
      'items-center',
    ]);
    cleanup();
  });

  it('wraps, justifies, and aligns on request', () => {
    const { container, cleanup } = render(
      <Inline as="footer" gap="item" align="baseline" justify="between" wrap>
        <span>A</span>
      </Inline>,
    );
    expect(classesOf(container.querySelector('footer'))).toEqual([
      'flex',
      'gap-3',
      'items-baseline',
      'justify-between',
      'flex-wrap',
    ]);
    cleanup();
  });
});
