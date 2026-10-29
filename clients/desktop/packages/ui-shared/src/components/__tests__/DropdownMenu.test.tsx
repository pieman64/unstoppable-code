/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_MENU_ROW_STYLE,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuStatusRow,
  DropdownMenuSurface,
} from '../DropdownMenu';

describe('DropdownMenu', () => {
  it('keeps surface and item corners concentric', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuSurface className="w-56">
        <DropdownMenuItem>
          <DropdownMenuItemIcon>
            <svg width={12} height={12} />
          </DropdownMenuItemIcon>
          Overview
        </DropdownMenuItem>
      </DropdownMenuSurface>,
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain(
      'rounded-lg bg-quaternary outline-none p-1 shadow-xl w-56',
    );
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('h-8 w-full');
    expect(html).toContain('rounded-md px-2');
    expect(html).toContain('h-4 w-4 shrink-0');
    expect(html).toContain('[&amp;&gt;svg]:!h-4');
    expect(html).toContain('[&amp;&gt;svg]:!w-4');
  });

  it('gives rows the sidebar rows\u2019 corners when the row style asks', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuRowStyleProvider
        value={{ textStyle: 'small', iconTone: 'inherit', corners: 'row' }}
      >
        <DropdownMenuItem>Changes</DropdownMenuItem>
      </DropdownMenuRowStyleProvider>,
    );
    expect(html).toContain('h-8 w-full items-center gap-2 rounded-row px-2');
    expect(html).not.toContain('rounded-md');
  });

  it('draws quiet rows with small text and tertiary icons, sparing meaningful ink', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
        <DropdownMenuItem data-testid="plain">
          <DropdownMenuItemIcon data-testid="plain-icon">
            <svg />
          </DropdownMenuItemIcon>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem tone="destructive" data-testid="danger">
          <DropdownMenuItemIcon data-testid="danger-icon">
            <svg />
          </DropdownMenuItemIcon>
          Delete
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <DropdownMenuItemIcon data-testid="disabled-icon">
            <svg />
          </DropdownMenuItemIcon>
          Archive
        </DropdownMenuItem>
      </DropdownMenuRowStyleProvider>,
    );
    const plain = host.querySelector('[data-testid="plain"]');
    expect(plain?.className).toContain('text-xs');
    expect(plain?.className).not.toContain('text-s ');
    expect(
      host.querySelector('[data-testid="plain-icon"]')?.className,
    ).toContain('fg-tertiary');
    // A destructive or disabled row keeps its own ink on the icon.
    expect(
      host.querySelector('[data-testid="danger-icon"]')?.className,
    ).not.toContain('fg-tertiary');
    expect(
      host.querySelector('[data-testid="disabled-icon"]')?.className,
    ).not.toContain('fg-tertiary');
  });

  it.each([
    ['no provider', undefined],
    ['the default row style', DEFAULT_MENU_ROW_STYLE],
  ])('keeps body text and row-ink icons with %s', (_name, style) => {
    const row = (
      <DropdownMenuItem>
        <DropdownMenuItemIcon>
          <svg />
        </DropdownMenuItemIcon>
        Set label
      </DropdownMenuItem>
    );
    const html = renderToStaticMarkup(
      style === undefined ? (
        row
      ) : (
        <DropdownMenuRowStyleProvider value={style}>
          {row}
        </DropdownMenuRowStyleProvider>
      ),
    );
    expect(html).toContain('text-left text-s font-normal');
    expect(html).not.toContain('text-xs');
    expect(html).not.toContain('fg-tertiary');
  });

  it('shares selected, accent, info, destructive, label, and divider treatments', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuSurface>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem selected>Selected</DropdownMenuItem>
        <DropdownMenuItem tone="accent">Connect</DropdownMenuItem>
        <DropdownMenuItem tone="info">Learn more</DropdownMenuItem>
        <DropdownMenuItem tone="destructive">Delete</DropdownMenuItem>
        <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
        <DropdownMenuDivider />
      </DropdownMenuSurface>,
    );

    expect(html).toContain('bg-muted fg-primary');
    expect(html).toContain(
      'bg-accent fg-emphasis enabled:hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    expect(html).toContain('fg-blue enabled:hover:bg-subtle');
    expect(html).toContain(
      'fg-destructive enabled:hover:bg-destructive-subtle',
    );
    expect(html).toContain('focus-visible:bg-subtle');
    expect(html).toContain('disabled:fg-disabled');
    expect(html).toContain('disabled:hover:bg-transparent');
    expect(html).toContain('role="separator"');
    // The divider lines up with the rows' content, not the surface edge.
    expect(html).toContain('class="mx-2 my-1 border-t');
  });
  it('lines a status row up with the action rows without making it one', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <>
        <DropdownMenuItem data-testid="action">
          <DropdownMenuItemIcon>
            <svg />
          </DropdownMenuItemIcon>
          Settings
        </DropdownMenuItem>
        <DropdownMenuStatusRow data-testid="status">
          <DropdownMenuItemIcon data-testid="status-icon">
            <svg />
          </DropdownMenuItemIcon>
          Sync paused
        </DropdownMenuStatusRow>
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuStatusRow data-testid="quiet">
            <DropdownMenuItemIcon data-testid="quiet-icon">
              <svg />
            </DropdownMenuItemIcon>
            Sync paused
          </DropdownMenuStatusRow>
        </DropdownMenuRowStyleProvider>
      </>,
    );
    const tokens = (testId: string): string[] =>
      (host.querySelector(`[data-testid="${testId}"]`)?.className ?? '').split(
        /\s+/,
      );
    const status = host.querySelector('[data-testid="status"]');
    expect(status?.tagName).toBe('DIV');
    expect(status?.getAttribute('role')).toBe('status');
    for (const token of [
      'flex',
      'h-8',
      'w-full',
      'items-center',
      'gap-2',
      'rounded-md',
      'px-2',
      'text-s',
      'font-normal',
      'fg-primary',
    ]) {
      expect(tokens('action')).toContain(token);
      expect(tokens('status')).toContain(token);
    }
    // No hover surface or focus ring: there is nothing to activate.
    expect(tokens('status').join(' ')).not.toMatch(/hover:|focus/);
    // The quiet menu style reaches it like any plain row.
    expect(tokens('quiet')).toContain('text-xs');
    expect(tokens('quiet-icon')).toContain('fg-tertiary');
    expect(tokens('status-icon')).not.toContain('fg-tertiary');
  });

  it('quiet menus step section labels back, identity blocks keep their ink', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <>
        <DropdownMenuLabel data-testid="default">Sort by</DropdownMenuLabel>
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuLabel data-testid="quiet">Sort by</DropdownMenuLabel>
          <DropdownMenuLabel data-testid="identity" spacing="relaxed">
            Ada
          </DropdownMenuLabel>
        </DropdownMenuRowStyleProvider>
      </>,
    );
    const inkOf = (testId: string): string[] =>
      (host.querySelector(`[data-testid="${testId}"]`)?.className ?? '')
        .split(' ')
        .filter((name) => name.startsWith('fg-'));
    expect(inkOf('default')).toEqual(['fg-secondary']);
    expect(inkOf('quiet')).toEqual(['fg-tertiary']);
    expect(inkOf('identity')).toEqual(['fg-secondary']);
  });
});
