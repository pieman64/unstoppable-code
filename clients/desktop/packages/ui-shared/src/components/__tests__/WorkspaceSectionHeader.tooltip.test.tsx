/**
 * @jest-environment jsdom
 *
 * jsdom-only behavior for `WorkspaceSectionHeader`'s repo-name tooltip: the
 * tooltip content is rendered via `createPortal` into `document.body`, so it
 * is not present in the SSR HTML. These tests exercise the hover/focus open
 * path and verify the truncated "+N more" overflow line.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderHeader(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function findTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Repositories:"]',
  );
  if (!trigger) {
    throw new Error('Tooltip trigger not found');
  }
  return trigger;
}

function findPortalTooltip(): HTMLDivElement | null {
  return document.body.querySelector<HTMLDivElement>('div[role="tooltip"]');
}

describe('WorkspaceSectionHeader repo-name tooltip (portal)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts the tooltip into document.body on open and lists every repo', () => {
    const { container, root } = renderHeader(
      <WorkspaceSectionHeader
        name="Adhoc"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={3}
        repoNames={['Repo A', 'Repo B', 'Repo C']}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    try {
      // Closed: no portal tooltip in the DOM yet.
      expect(findPortalTooltip()).toBeNull();

      act(() => {
        findTrigger(container).focus();
      });

      const tooltip = findPortalTooltip();
      expect(tooltip).not.toBeNull();
      // The tooltip lives outside the trigger's subtree (rendered into body).
      expect(container.contains(tooltip)).toBe(false);
      expect(tooltip?.textContent).toContain('Repositories');
      expect(tooltip?.textContent).toContain('Repo A');
      expect(tooltip?.textContent).toContain('Repo B');
      expect(tooltip?.textContent).toContain('Repo C');
      expect(tooltip?.textContent).not.toMatch(/\+\s*\d+\s+more/);
      expect(tooltip?.className).toContain('shadow-tooltip');
      expect(tooltip?.className).not.toContain('border');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('opens the tooltip on focus and unmounts it on blur', () => {
    const { container, root } = renderHeader(
      <WorkspaceSectionHeader
        name="Adhoc"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={2}
        repoNames={['Repo A', 'Repo B']}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        trigger.focus();
      });
      expect(findPortalTooltip()).not.toBeNull();

      act(() => {
        trigger.blur();
      });
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('truncates the visible list to 12 repos and shows a + N more line', () => {
    const repoNames = Array.from({ length: 15 }, (_, idx) => `Repo ${idx + 1}`);
    const { container, root } = renderHeader(
      <WorkspaceSectionHeader
        name="Big"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={repoNames.length}
        repoNames={repoNames}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    try {
      act(() => {
        findTrigger(container).focus();
      });

      const tooltip = findPortalTooltip();
      expect(tooltip).not.toBeNull();
      const text = tooltip?.textContent ?? '';
      expect(text).toContain('Repo 1');
      expect(text).toContain('Repo 12');
      expect(text).not.toContain('Repo 13');
      expect(text).not.toContain('Repo 14');
      expect(text).not.toContain('Repo 15');
      expect(text).toContain('+ 3 more');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('positions the tooltip inside the viewport, clamping against the right edge', () => {
    const repoNames = ['Repo A', 'Repo B'];
    const { container, root } = renderHeader(
      <WorkspaceSectionHeader
        name="Edge"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={repoNames.length}
        repoNames={repoNames}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    try {
      const trigger = findTrigger(container);
      // Pin the viewport and trigger geometry. jsdom returns zeros by default
      // for layout, so override what the positioner reads to simulate a
      // trigger anchored near the right viewport edge.
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 600,
      });
      jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 116,
        left: 780,
        right: 800,
        width: 20,
        height: 16,
        x: 780,
        y: 100,
        toJSON: () => ({}),
      });

      // Patch the tooltip element prototype to expose non-zero dimensions
      // before mount so the very first updatePosition call clamps correctly.
      const offsetWidthSpy = jest
        .spyOn(HTMLDivElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(220);
      const offsetHeightSpy = jest
        .spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(80);

      try {
        act(() => {
          trigger.focus();
        });

        const tooltip = findPortalTooltip();
        expect(tooltip).not.toBeNull();

        const style = tooltip?.style;
        if (!style) throw new Error('Tooltip style missing');
        const left = parseFloat(style.left || '0');
        // Tooltip width (220) + padding (8) leaves at most 572px on an 800px
        // viewport. The clamp should produce a non-negative integer left value
        // and never exceed that ceiling.
        expect(left).toBeLessThanOrEqual(572);
        expect(left).toBeGreaterThanOrEqual(0);
      } finally {
        offsetWidthSpy.mockRestore();
        offsetHeightSpy.mockRestore();
      }
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
