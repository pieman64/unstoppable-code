/** @jest-environment jsdom */

/**
 * Right-click actions on a workspace row (shareable workspace templates).
 *
 * The load-bearing behavior is the served gate: a host that cannot serve any
 * action gets no menu at all — not a disabled row — so the browser's own
 * context menu is left alone.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function stubMatchMedia(): void {
  window.matchMedia = jest.fn().mockImplementation(
    (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as MediaQueryList,
  );
}

function contextMenuEvent(): MouseEvent {
  return new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 80,
  });
}

describe('WorkspaceSectionHeader context menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderHeader(
    actions?: React.ComponentProps<
      typeof WorkspaceSectionHeader
    >['contextMenuActions'],
  ): void {
    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Course workspace"
          workspaceType="cowork"
          worktreeCount={2}
          collapsed={false}
          onToggleCollapse={(): void => undefined}
          dataTestId="workspace-header"
          contextMenuActions={actions}
        />,
      );
    });
  }

  it('opens a Share template item and runs it on select', () => {
    const onSelect = jest.fn();
    renderHeader([
      {
        id: 'share-template',
        label: 'Share template',
        testId: 'workspace-share-template-menu-item',
        onSelect,
      },
    ]);

    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    expect(header).not.toBeNull();
    act(() => {
      header?.dispatchEvent(contextMenuEvent());
    });

    const item = document.body.querySelector<HTMLElement>(
      '[data-testid="workspace-share-template-menu-item"]',
    );
    expect(item?.textContent).toBe('Share template');

    act(() => {
      item?.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector(
        '[data-testid="workspace-share-template-menu-item"]',
      ),
    ).toBeNull();
  });

  it('renders a host-supplied leading icon on a context action', () => {
    renderHeader([
      {
        id: 'share-template',
        label: 'Share template',
        testId: 'workspace-share-template-menu-item',
        icon: <svg data-testid="share-template-icon" />,
        onSelect: (): void => undefined,
      },
    ]);

    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    act(() => {
      header?.dispatchEvent(contextMenuEvent());
    });

    const item = document.body.querySelector<HTMLElement>(
      '[data-testid="workspace-share-template-menu-item"]',
    );
    // The glyph leads the row on the same rail every other menu uses, so the
    // labels stay aligned with icon-bearing rows elsewhere.
    const icon = item?.querySelector('[data-testid="share-template-icon"]');
    expect(icon).not.toBeNull();
    expect(icon?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(item?.firstElementChild?.contains(icon ?? null)).toBe(true);
    expect(item?.textContent).toBe('Share template');
  });

  it('renders no menu when the host serves no actions', () => {
    renderHeader(undefined);

    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    const event = contextMenuEvent();
    act(() => {
      header?.dispatchEvent(event);
    });

    // Not merely empty — absent, and the browser menu is left un-prevented.
    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  function pressEscape(): void {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it('returns focus to the header when Escape closes a right-click menu', () => {
    renderHeader([
      {
        id: 'share-template',
        label: 'Share template',
        testId: 'workspace-share-template-menu-item',
        onSelect: (): void => undefined,
      },
    ]);
    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    act(() => {
      header?.dispatchEvent(contextMenuEvent());
    });
    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).not.toBeNull();

    pressEscape();

    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).toBeNull();
    // The header is the menu's initiating control; the pointer-positioned
    // anchor is an inert span that cannot hold focus.
    expect(document.activeElement).toBe(header);
  });

  it('returns focus to the options button when Escape closes its menu', () => {
    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Course workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={false}
          onToggleCollapse={(): void => undefined}
          dataTestId="workspace-header"
          optionsOpensContextMenu
          renderContextMenuItems={(): React.ReactNode => (
            <button type="button" role="menuitem">
              Project settings
            </button>
          )}
        />,
      );
    });
    const options = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Course workspace"]',
    );
    expect(options).not.toBeNull();
    act(() => {
      options?.focus();
      options?.click();
    });
    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).not.toBeNull();

    pressEscape();

    expect(document.activeElement).toBe(options);
  });

  it('hides the options button for fine pointers on request, keeping right-click', () => {
    const renderWith = (hideOptionsForFinePointer: boolean): void => {
      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Course workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            onToggleCollapse={(): void => undefined}
            dataTestId="workspace-header"
            optionsOpensContextMenu
            hideOptionsForFinePointer={hideOptionsForFinePointer}
            renderContextMenuItems={(): React.ReactNode => (
              <button type="button" role="menuitem">
                Project settings
              </button>
            )}
          />,
        );
      });
    };
    const hiddenForFinePointer = (): boolean =>
      container
        .querySelector('button[aria-label="More actions for Course workspace"]')
        ?.closest('.pointer-fine\\:hidden') !== null;

    renderWith(false);
    expect(hiddenForFinePointer()).toBe(false);

    renderWith(true);
    // Still mounted, for touch, which has no right-click.
    expect(hiddenForFinePointer()).toBe(true);
    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    act(() => {
      header?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).not.toBeNull();
  });

  it('renders no menu for an empty action list', () => {
    renderHeader([]);

    const header = container.querySelector<HTMLElement>(
      '[data-testid="workspace-header"]',
    );
    act(() => {
      header?.dispatchEvent(contextMenuEvent());
    });

    expect(
      document.body.querySelector(
        '[data-testid="workspace-section-context-menu"]',
      ),
    ).toBeNull();
  });
});
