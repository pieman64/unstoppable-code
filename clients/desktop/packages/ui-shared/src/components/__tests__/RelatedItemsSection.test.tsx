/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  RelatedItemsSection,
  type RelatedItemRow,
} from '../RelatedItemsSection';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../../lib/customize-grid';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ITEMS: RelatedItemRow[] = [
  {
    key: 'deploy',
    icon: '🚀',
    title: 'Deploy',
    subtitle: 'Bundled pipeline',
    badge: 'Bundled',
    reason: 'Runs the skill you are viewing',
    onOpen: (): void => {},
  },
  { key: 'lint', title: 'Lint', onOpen: (): void => {} },
];

function mount(element: React.ReactElement): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

function render(
  overrides: Partial<React.ComponentProps<typeof RelatedItemsSection>> = {},
): { container: HTMLElement; root: Root } {
  return mount(
    <RelatedItemsSection
      title="Related pipelines"
      emptyLabel="No related pipelines."
      items={ITEMS}
      testId="related-pipelines"
      {...overrides}
    />,
  );
}

describe('RelatedItemsSection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the section heading', () => {
    const { container, root } = render();
    expect(container.textContent).toContain('Related pipelines');
    act(() => root.unmount());
  });

  it('opens the item a row stands for', () => {
    const onOpen = jest.fn();
    const { container, root } = render({
      items: [{ key: 'deploy', title: 'Deploy', onOpen }],
    });
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="related-pipelines-item-deploy"]',
    );
    act(() => row?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('highlights a row on hover', () => {
    // The rows are buttons, so they need the app's row hover. It belongs
    // INSIDE this component: every host renders the shared primitive, and the
    // design-lint rules reject a restyling class at the call site.
    // `hover:bg-surface-hover` used to sit here and no stylesheet declared
    // it, so the highlight never painted (removed as dead in #3791).
    // `hover:bg-subtle` is the row idiom the DropdownMenu items, the sidebar
    // rows, and SidebarPageNav already use.
    for (const presentation of ['cards', 'list'] as const) {
      const { container, root } = render({ presentation });
      for (const key of ['deploy', 'lint']) {
        const row = container.querySelector(
          `[data-testid="related-pipelines-item-${key}"]`,
        );
        expect(row?.classList.contains('hover:bg-subtle')).toBe(true);
        expect(row?.classList.contains('cursor-pointer')).toBe(true);
      }
      expect(container.innerHTML).not.toContain('hover:bg-surface-hover');
      act(() => root.unmount());
    }
  });

  // CAN-4261: Related rows read like the Customize list rows: an avatar, the
  // name with its tinted type, the inset rounded hover card, in the same
  // two-column grid; no divider list with chevrons.
  it('lists rows as Customize row cards in the shared grid', () => {
    const { container, root } = render({
      presentation: 'list',
      items: [
        {
          key: 'copy',
          title: 'Copy Review',
          subtitle: 'Checks UI copy',
          badge: 'Skill',
          kind: 'skill',
          onOpen: (): void => {},
        },
      ],
    });
    const grid = container.querySelector(
      '[data-testid="related-pipelines-rows"]',
    );
    for (const cls of CUSTOMIZE_ROW_GRID_CLASS.split(' '))
      expect(grid?.classList.contains(cls)).toBe(true);
    expect(grid?.classList.contains('divide-y')).toBe(false);
    const row = container.querySelector(
      '[data-testid="related-pipelines-item-copy"]',
    );
    expect(row?.classList.contains('rounded-xl')).toBe(true);
    expect(row?.classList.contains('px-4')).toBe(true);
    expect(
      row?.querySelector('[data-testid="related-pipelines-item-copy-avatar"]'),
    ).not.toBeNull();
    expect(row?.querySelector('svg[data-glyph^="chevron"]')).toBeNull();
    act(() => root.unmount());
  });

  it('renders the empty state, and nothing at all while loading', () => {
    const { container, root } = render({ items: [] });
    expect(
      container.querySelector('[data-testid="related-pipelines-empty"]')
        ?.textContent,
    ).toBe('No related pipelines.');
    act(() => root.unmount());

    const loading = render({ items: [], loading: true });
    expect(
      loading.container.querySelector(
        '[data-testid="related-pipelines-empty"]',
      ),
    ).toBeNull();
    act(() => loading.root.unmount());
  });
});
