/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ArchivedContainersNavLink,
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
  WorkspaceSectionHeader,
} from '@canopy/ui-shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ArchivedContainersNavLink', () => {
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

  function render(props: {
    count: number;
    selected?: boolean;
    onOpen?: () => void;
  }): void {
    act(() => {
      root.render(
        <ArchivedContainersNavLink
          count={props.count}
          selected={props.selected ?? false}
          onOpen={props.onOpen ?? ((): void => undefined)}
          testId="sidebar-project-ws-1-archived-link"
        />,
      );
    });
  }

  it('renders nothing when the project has no retained items', () => {
    render({ count: 0 });
    expect(container.innerHTML).toBe('');
  });

  it('shows the count, navigates away on click, and never lists rows inline', () => {
    const onOpen = jest.fn();
    render({ count: 3, onOpen });
    const link = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-project-ws-1-archived-link"]',
    );
    // The count is no longer part of the title: the label and the number are
    // separate elements, and the link still reads as one phrase.
    expect(link?.textContent).toBe('Archived and deleted 3');
    expect(
      link?.querySelector(
        '[data-testid="sidebar-project-ws-1-archived-link-label"]',
      )?.textContent,
    ).toBe('Archived and deleted');
    expect(
      link?.querySelector(
        '[data-testid="sidebar-project-ws-1-archived-link-count"]',
      )?.textContent,
    ).toBe('3');
    expect(link?.querySelector('svg')).not.toBeNull();
    expect(link?.getAttribute('aria-expanded')).toBeNull();
    expect(link?.getAttribute('data-selected')).toBe('false');
    act(() => {
      link?.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('styles the count with the same classes as the count beside a project name', () => {
    act(() => {
      root.render(
        <>
          <WorkspaceSectionHeader
            name="Canopy"
            workspaceType="single-repo"
            worktreeCount={5}
            textScale="sidebar"
            collapsed={false}
            onToggleCollapse={(): void => undefined}
          />
          <ArchivedContainersNavLink
            count={3}
            selected={false}
            onOpen={(): void => undefined}
            testId="sidebar-project-ws-1-archived-link"
          />
        </>,
      );
    });
    const projectCount = container.querySelector(
      '[data-testid="workspace-section-counter"]',
    );
    const archivedCount = container.querySelector(
      '[data-testid="sidebar-project-ws-1-archived-link-count"]',
    );
    expect(projectCount?.textContent).toBe('5');
    expect(archivedCount?.textContent).toBe('3');
    const counterClasses = SIDEBAR_ROW_TRAILING_CELL_CLASSNAME.split(' ');
    expect(counterClasses.length).toBeGreaterThan(0);
    for (const className of counterClasses) {
      expect(projectCount?.classList.contains(className)).toBe(true);
      expect(archivedCount?.classList.contains(className)).toBe(true);
    }
  });

  it('sits on the standard row grid, glyph in the leading slot', () => {
    render({ count: 2 });
    const link = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-project-ws-1-archived-link"]',
    );
    for (const className of ['gap-1.5', 'pl-1.5', 'pr-1.5']) {
      expect(link?.classList.contains(className)).toBe(true);
    }
    const slot = link?.firstElementChild;
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.querySelector('svg')).not.toBeNull();
    for (const className of ['h-5', 'w-5', 'shrink-0']) {
      expect(slot?.classList.contains(className)).toBe(true);
    }
  });

  it('marks the link as the current page while its overview is open', () => {
    render({ count: 1, selected: true });
    const link = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-project-ws-1-archived-link"]',
    );
    expect(link?.getAttribute('data-selected')).toBe('true');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });
});
