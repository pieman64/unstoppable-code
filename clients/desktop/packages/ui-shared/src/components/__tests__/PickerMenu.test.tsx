/** @jest-environment jsdom */

import { act, createRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FloatingPickerMenu,
  PickerMenuFooter,
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuSection,
  PickerMenuSectionLabel,
  PickerMenuSkeleton,
  PickerMenuState,
  PickerMenuTab,
  PickerMenuTabList,
} from '../PickerMenu';
import { ContextMenuPlacementProvider } from '../context-menu-placement';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function PickerFixture(): JSX.Element {
  const anchorRef = createRef<HTMLButtonElement>();
  return (
    <>
      <button ref={anchorRef} type="button">
        Project
      </button>
      <FloatingPickerMenu
        open
        onOpenChange={jest.fn()}
        anchorRef={anchorRef}
        placement="bottom-left"
        minimumWidth="16rem"
        role="dialog"
      >
        <PickerMenuSearchHeader>
          <PickerMenuSearchInput aria-label="Search" />
        </PickerMenuSearchHeader>
        <PickerMenuTabList aria-label="Sources">
          <PickerMenuTab role="tab" active aria-selected="true">
            Worktrees
          </PickerMenuTab>
          <PickerMenuTab role="tab" aria-selected="false">
            Pull requests
          </PickerMenuTab>
        </PickerMenuTabList>
        <PickerMenuList aria-label="Options">
          <PickerMenuOption role="option" selected active>
            <PickerMenuOptionLeading>
              <svg aria-label="leading icon" />
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>
                A very long branch name
              </PickerMenuOptionLabel>
              <PickerMenuOptionDescription>
                worktree-id
              </PickerMenuOptionDescription>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected />
          </PickerMenuOption>
          <PickerMenuSection>
            <PickerMenuSectionLabel>Existing worktrees</PickerMenuSectionLabel>
            <PickerMenuOption role="option" active>
              <PickerMenuOptionLeading />
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>Other branch</PickerMenuOptionLabel>
              </PickerMenuOptionContent>
              <PickerMenuOptionTrailing>local</PickerMenuOptionTrailing>
            </PickerMenuOption>
          </PickerMenuSection>
          <PickerMenuState data-testid="picker-empty">
            No projects match
          </PickerMenuState>
        </PickerMenuList>
        <PickerMenuFooter data-testid="picker-footer">
          <PickerMenuOption>
            <PickerMenuOptionLeading />
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>New project</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected={false} />
          </PickerMenuOption>
        </PickerMenuFooter>
      </FloatingPickerMenu>
    </>
  );
}

describe('PickerMenu anatomy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('shares one shell, 32px rows, and truncating content', () => {
    act(() => root.render(<PickerFixture />));

    const menu = document.querySelector<HTMLElement>('.canopy-picker-menu');
    const searchHeader = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-search',
    );
    const searchField = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-search-field',
    );
    const searchIcon = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-search-icon',
    );
    const search = document.querySelector<HTMLInputElement>(
      '.canopy-picker-menu-search input',
    );
    const list = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-list',
    );
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('.canopy-picker-menu-option'),
    );
    const tablist = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-tabs',
    );
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>('.canopy-picker-menu-tab'),
    );
    const sectionLabel = document.querySelector<HTMLElement>(
      '.canopy-picker-menu-section-label',
    );

    expect(menu).not.toBeNull();
    expect(menu?.classList).toContain('canopy-floating-menu');
    expect(menu?.style.getPropertyValue('--canopy-picker-minimum-width')).toBe(
      '16rem',
    );
    expect(searchField?.className).toContain('h-8');
    expect(searchField?.className).toContain('gap-2');
    expect(searchField?.className).toContain('px-2');
    expect(searchIcon?.className).toContain('h-4');
    expect(searchIcon?.className).toContain('w-4');
    expect(searchIcon?.className).toContain('fg-quaternary');
    expect(searchIcon?.querySelector('svg')).not.toBeNull();
    expect(search?.className).toContain('border-0');
    expect(search?.className).toContain('bg-transparent');
    expect(search?.className).not.toContain('h-8');
    expect(search?.className).not.toContain('px-2');
    expect(list?.className).toContain('overflow-x-hidden');
    expect(list?.className).toContain('overflow-y-auto');
    expect(rows).toHaveLength(3);
    // Selected uses the checkmark only — no bg, even when also active.
    expect(rows[0]?.classList).not.toContain('bg-subtle');
    expect(rows[0]?.getAttribute('data-selected')).toBe('true');
    expect(rows[0]?.classList).toContain('fg-primary');
    expect(rows[0]?.classList).toContain('hover:bg-subtle');
    expect(
      rows[0]?.querySelector('.canopy-picker-menu-option-trailing'),
    ).toBeNull();
    // Active (keyboard/hover target) still gets the soft bg when unselected.
    expect(rows[1]?.classList).toContain('bg-subtle');
    expect(rows[1]?.classList).toContain('hover:bg-subtle');
    expect(rows[1]?.classList).toContain('fg-primary');
    expect(
      rows[1]?.querySelector('.canopy-picker-menu-option-trailing')?.className,
    ).toContain('fg-quaternary');
    expect(rows[2]?.classList).not.toContain('bg-subtle');
    expect(tablist?.className).toContain('border-b');
    expect(tablist?.className).not.toContain('pt-1');
    expect(tablist?.className).not.toContain('pb-1');
    expect(tablist?.className).not.toContain('py-1');
    expect(tablist?.className).toContain('-mx-1');
    expect(tablist?.className).toContain('px-1');
    expect(searchHeader?.className).toContain('-mx-1');
    expect(searchHeader?.className).toContain('px-1');
    expect(searchHeader?.className).toContain('border-b');
    expect(searchHeader?.className).toContain('pt-1');
    expect(searchHeader?.className).toContain('pb-1');
    expect(
      document.querySelector('[data-testid="picker-footer"]')?.className,
    ).toContain('-mx-1');
    expect(
      document.querySelector('[data-testid="picker-footer"]')?.className,
    ).toContain('px-1');
    expect(
      document.querySelector('[data-testid="picker-footer"]')?.className,
    ).toContain('pt-1');
    expect(
      document.querySelector('[data-testid="picker-footer"]')?.className,
    ).toContain('pb-1');
    expect(
      document.querySelector('[data-testid="picker-footer"]')?.className,
    ).not.toContain('mt-1');
    expect(
      document.querySelector('.canopy-picker-menu-section')?.className,
    ).toContain('-mx-1');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.className).toContain('h-8');
    expect(tabs[0]?.className).toContain('inline-flex');
    expect(tabs[0]?.className).toContain('items-center');
    expect(tabs[0]?.className).toContain('justify-center');
    expect(tabs[0]?.className).toContain('text-xs');
    expect(tabs[0]?.className).toContain('px-2');
    expect(tabs[0]?.className).toContain('whitespace-nowrap');
    expect(tabs[0]?.className).not.toContain('truncate');
    expect(tabs[0]?.className).toContain('fg-primary');
    expect(tabs[0]?.className).not.toContain('bg-subtle');
    expect(tabs[0]?.className).not.toContain('bg-muted');
    expect(tabs[0]?.className).not.toContain('rounded-md');
    expect(tabs[0]?.getAttribute('data-active')).toBe('true');
    expect(tabs[1]?.className).toContain('fg-secondary');
    expect(tabs[1]?.className).not.toContain('bg-subtle');
    expect(sectionLabel?.className).toContain('py-1');
    expect(sectionLabel?.className).toContain('text-xs');
    expect(sectionLabel?.className).toContain('font-normal');
    expect(sectionLabel?.className).toContain('normal-case');
    expect(sectionLabel?.className).toContain('fg-tertiary');
    expect(
      document.querySelector('[data-testid="picker-empty"]')?.className,
    ).toContain('min-h-8');
    expect(
      document.querySelector('[data-testid="picker-empty"]')?.className,
    ).toContain('py-2');
    expect(
      document.querySelector('[data-testid="picker-empty"]')?.className,
    ).toContain('leading-snug');
    expect(
      document
        .querySelector('[data-testid="picker-empty"]')
        ?.className.split(/\s+/),
    ).not.toContain('h-8');
    expect(
      document.querySelector('[data-testid="picker-empty"]')?.className,
    ).toContain('fg-tertiary');
    expect(sectionLabel?.className).not.toContain('uppercase');
    expect(sectionLabel?.className).not.toContain('font-semibold');
    expect(
      document.querySelector('[data-testid="picker-footer"]'),
    ).not.toBeNull();
    // Search sits above the underlined tabs so filtering leads the menu.
    if (!searchHeader || !tablist) {
      throw new Error('expected picker search header and tab list');
    }
    expect(
      searchHeader.compareDocumentPosition(tablist) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    for (const row of rows) {
      expect(row.className.split(' ')).toEqual(
        expect.arrayContaining([
          'min-h-8',
          'py-2',
          'min-w-0',
          'gap-2',
          'rounded-md',
          'px-2',
          'text-s',
        ]),
      );
      expect(row.className.split(' ')).not.toContain('h-8');
      expect(row.querySelector('.h-4.w-4.shrink-0')).not.toBeNull();
      expect(row.querySelector('.min-w-0.flex-1')).not.toBeNull();
    }

    expect(rows[0]?.querySelector('.truncate.leading-4')).not.toBeNull();
    expect(rows[0]?.querySelector('.truncate.leading-3')).not.toBeNull();
    expect(
      rows[0]?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(
      rows[0]?.querySelector('[data-picker-selected-check="true"]')?.classList,
    ).toContain('fg-primary');
    expect(
      rows[0]
        ?.querySelector('[data-picker-selected-check="true"] svg')
        ?.getAttribute('data-glyph'),
    ).toBe('check');
    // Unselected status-icon rows omit the check; selecting replaces the icon.
    expect(rows[1]?.querySelector('[data-picker-selected-check]')).toBeNull();
    expect(
      rows[1]?.querySelector('.canopy-picker-menu-option-trailing'),
    ).not.toBeNull();
    expect(rows[2]?.querySelector('[data-picker-selected-check]')).toBeNull();
  });

  it('draws 32px placeholder rows announced as one loading status', () => {
    act(() =>
      root.render(
        <PickerMenuSkeleton
          rows={4}
          label="Loading branches"
          data-testid="picker-skeleton"
        />,
      ),
    );

    const skeleton = container.querySelector('[data-testid="picker-skeleton"]');
    expect(skeleton?.getAttribute('role')).toBe('status');
    expect(skeleton?.textContent).toBe('Loading branches');
    const rows = skeleton?.querySelectorAll('[aria-hidden="true"]');
    expect(rows).toHaveLength(4);
    expect(rows?.[0]?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-8', 'px-2']),
    );
    expect(
      rows?.[0]?.querySelectorAll(
        '.animate-pulse.motion-reduce\\:animate-none',
      ),
    ).toHaveLength(2);
  });

  it('early access: rows and the search field take the row menus’ small text', () => {
    const sizes = (): (string | undefined)[] =>
      [
        'input',
        '.canopy-picker-menu-option',
        '.canopy-picker-menu-option-label',
      ].map((selector) =>
        Array.from(document.querySelector(selector)?.classList ?? []).find(
          (name) => name === 'text-xs' || name === 'text-s',
        ),
      );
    // Other hosts (web, desktop without early access) keep the body size.
    act(() => root.render(<PickerFixture />));
    expect(sizes()).toEqual(['text-s', 'text-s', 'text-s']);

    act(() =>
      root.render(
        <ContextMenuPlacementProvider value="cursor">
          <PickerFixture />
        </ContextMenuPlacementProvider>,
      ),
    );
    expect(sizes()).toEqual(['text-xs', 'text-xs', 'text-xs']);
  });
});
