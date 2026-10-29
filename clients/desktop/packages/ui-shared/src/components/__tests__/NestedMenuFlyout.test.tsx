/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { NestedMenuFlyout } from '../NestedMenuFlyout';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { DropdownMenuItem } from '../DropdownMenu';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('ArrowLeft closes a keyboard flyout and returns focus to its trigger', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <NestedMenuFlyout
          label="Group"
          triggerTestId="group-trigger"
          menuTestId="group-menu"
        >
          <DropdownMenuItem>Move</DropdownMenuItem>
        </NestedMenuFlyout>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="group-trigger"]',
    );
    void act(() =>
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(
      document.body.querySelector('[data-testid="group-menu"]'),
    ).not.toBeNull();
    void act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      ),
    );
    expect(
      document.body.querySelector('[data-testid="group-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

function leadingClassTokens(html: string): string[] {
  // The leading slot is the first aria-hidden span inside the trigger row.
  const tag = /<span aria-hidden="true"[^>]*>/.exec(html)?.[0] ?? '';
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
}

function render(leadingTone?: 'secondary' | 'accent'): string {
  return renderToStaticMarkup(
    <NestedMenuFlyout
      label="More models"
      triggerTestId="more-trigger"
      menuTestId="more-menu"
      leading={<svg data-testid="glyph" />}
      leadingTone={leadingTone}
    >
      rows
    </NestedMenuFlyout>,
  );
}

describe('NestedMenuFlyout leading tone', () => {
  it('lets the leading glyph inherit the row ink by default', () => {
    const tokens = leadingClassTokens(render());

    expect(tokens).toContain('h-4');
    expect(tokens).not.toContain('fg-secondary');
    expect(tokens).not.toContain('fg-accent');
  });

  it('quiets a catalog glyph and marks the flyout holding the selection', () => {
    expect(leadingClassTokens(render('secondary'))).toContain('fg-secondary');
    expect(leadingClassTokens(render('accent'))).toContain('fg-accent');
  });
});

describe('NestedMenuFlyout siblings', () => {
  function hover(target: Element | null, from: Element | null = null): void {
    void act(() => {
      from?.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: target }),
      );
      target?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: from }),
      );
    });
  }

  function renderSiblings(): { root: Root; container: HTMLDivElement } {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    void act(() =>
      root.render(
        <div role="menu">
          <NestedMenuFlyout
            label="Group"
            triggerTestId="group-trigger"
            menuTestId="group-menu"
          >
            <DropdownMenuItem>Edit group…</DropdownMenuItem>
          </NestedMenuFlyout>
          <NestedMenuFlyout
            label="Notifications"
            triggerTestId="notifications-trigger"
            menuTestId="notifications-menu"
          >
            <DropdownMenuItem>All activity</DropdownMenuItem>
          </NestedMenuFlyout>
          <NestedMenuFlyout
            label="More"
            triggerTestId="more-trigger"
            menuTestId="more-menu"
          >
            <DropdownMenuItem>Branch info</DropdownMenuItem>
            <NestedMenuFlyout
              label="Move to"
              triggerTestId="move-trigger"
              menuTestId="move-menu"
            >
              <DropdownMenuItem>Group</DropdownMenuItem>
              <NestedMenuFlyout
                label="Project"
                triggerTestId="project-trigger"
                menuTestId="project-menu"
              >
                <DropdownMenuItem>Canopy</DropdownMenuItem>
              </NestedMenuFlyout>
            </NestedMenuFlyout>
          </NestedMenuFlyout>
        </div>,
      ),
    );
    return { root, container };
  }

  const byTestId = (id: string): Element | null =>
    document.body.querySelector(`[data-testid="${id}"]`);

  it('closes the open sibling at once when another one opens', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      hover(byTestId('notifications-trigger'));
      expect(byTestId('notifications-menu')).not.toBeNull();

      hover(byTestId('more-trigger'), byTestId('notifications-trigger'));

      // No grace period: only one submenu is ever on screen.
      expect(byTestId('more-menu')).not.toBeNull();
      expect(byTestId('notifications-menu')).toBeNull();
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('keeps a parent flyout open when its own child opens', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      hover(byTestId('more-trigger'));
      const moreMenu = byTestId('more-menu');
      hover(moreMenu, byTestId('more-trigger'));
      hover(byTestId('move-trigger'), moreMenu);

      expect(byTestId('move-menu')).not.toBeNull();
      expect(byTestId('more-menu')).not.toBeNull();
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('keeps every ancestor open when a deeper submenu opens', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      hover(byTestId('more-trigger'));
      hover(byTestId('move-trigger'), byTestId('more-trigger'));
      hover(byTestId('project-trigger'), byTestId('move-trigger'));

      expect(byTestId('project-menu')).not.toBeNull();
      expect(byTestId('move-menu')).not.toBeNull();
      expect(byTestId('more-menu')).not.toBeNull();
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('keeps focus in the menu when hovering away from a keyboard-opened submenu', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      const notifications = byTestId('notifications-trigger');
      void act(() =>
        notifications?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        ),
      );
      void act(() => jest.runAllTimers());
      expect(
        byTestId('notifications-menu')?.contains(document.activeElement),
      ).toBe(true);

      hover(byTestId('more-trigger'), notifications);

      expect(byTestId('notifications-menu')).toBeNull();
      expect(document.activeElement).toBe(byTestId('more-trigger'));
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  const openSubmenus = (): number =>
    document.body.querySelectorAll('[data-floating-menu-nested="true"]').length;

  function pressArrowRight(target: Element | null): void {
    void act(() =>
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
  }

  it('Group → More by pointer: Group closes at once and stays closed', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      hover(byTestId('group-trigger'));
      expect(byTestId('group-menu')).not.toBeNull();
      hover(byTestId('more-trigger'), byTestId('group-trigger'));
      expect(byTestId('group-menu')).toBeNull();
      expect(openSubmenus()).toBe(1);
      void act(() => jest.runAllTimers());
      expect(byTestId('group-menu')).toBeNull();
      expect(byTestId('more-menu')).not.toBeNull();
      expect(openSubmenus()).toBe(1);
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('a keyboard-opened Group closes when More opens by pointer, and stays closed', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      pressArrowRight(byTestId('group-trigger'));
      expect(byTestId('group-menu')).not.toBeNull();
      // No pointer ever left Group, so nothing else would close it.
      void act(() =>
        byTestId('more-trigger')?.dispatchEvent(
          new MouseEvent('pointerover', { bubbles: true }),
        ),
      );
      void act(() => jest.runAllTimers());
      expect(byTestId('group-menu')).toBeNull();
      expect(byTestId('more-menu')).not.toBeNull();
      expect(openSubmenus()).toBe(1);
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('Group → More by keyboard: opening More closes Group', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      pressArrowRight(byTestId('group-trigger'));
      expect(byTestId('group-menu')).not.toBeNull();
      pressArrowRight(byTestId('more-trigger'));
      void act(() => jest.runAllTimers());
      expect(byTestId('group-menu')).toBeNull();
      expect(byTestId('more-menu')).not.toBeNull();
      expect(openSubmenus()).toBe(1);
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('opening a top-level sibling closes another branch with all its nested submenus', () => {
    jest.useFakeTimers();
    const { root, container } = renderSiblings();
    try {
      hover(byTestId('more-trigger'));
      hover(byTestId('move-trigger'), byTestId('more-trigger'));
      hover(byTestId('project-trigger'), byTestId('move-trigger'));
      expect(openSubmenus()).toBe(3);

      hover(byTestId('group-trigger'), byTestId('project-trigger'));
      expect(byTestId('more-menu')).toBeNull();
      expect(byTestId('move-menu')).toBeNull();
      expect(byTestId('project-menu')).toBeNull();
      expect(byTestId('group-menu')).not.toBeNull();
      expect(openSubmenus()).toBe(1);
    } finally {
      void act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });
});
