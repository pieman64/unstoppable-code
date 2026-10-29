/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  SidebarChrome,
  SidebarList,
  SidebarRowFrame,
  SidebarSection,
} from '../sidebar';

describe('sidebar chrome primitives', () => {
  it('renders rail/drawer width and touch-density variants', () => {
    const rail = renderToString(
      <SidebarChrome data-testid="rail">Rail</SidebarChrome>,
    );
    const drawer = renderToString(
      <SidebarChrome variant="drawer" density="touch" data-anchor="drawer">
        Drawer
      </SidebarChrome>,
    );

    expect(rail).toContain('data-sidebar-variant="rail"');
    expect(rail).toContain('w-64');
    expect(drawer).toContain('data-sidebar-variant="drawer"');
    expect(drawer).toContain('data-sidebar-density="touch"');
    expect(drawer).toContain('data-anchor="drawer"');
    expect(drawer).not.toContain('[&amp;_button]:min-h-11');
    expect(drawer).not.toContain('[&amp;_button]:min-w-11');
    expect(drawer).toContain('w-full');
  });

  it('lets an inner host own scrolling and responsive height', () => {
    const out = renderToString(
      <SidebarChrome scroll="host" fullHeight={false}>
        Hosted
      </SidebarChrome>,
    );

    expect(out).toContain('overflow-hidden');
    expect(out).not.toContain('overflow-auto');
    expect(out).not.toContain('h-full');
  });

  it('owns scrolling and full height by default', () => {
    const out = renderToString(<SidebarChrome>Framed</SidebarChrome>);

    expect(out).toContain('overflow-auto');
    expect(out).not.toContain('overflow-hidden');
    expect(out).toContain('h-full');
  });

  it('paints the frame on the sidebar material only when asked', () => {
    const painted = renderToString(
      <SidebarChrome surface="sidebar">Rail</SidebarChrome>,
    );
    const plain = renderToString(<SidebarChrome>Rail</SidebarChrome>);

    expect(painted).toContain('bg-sidebar');
    expect(plain).not.toContain('bg-sidebar');
  });

  it('stacks the split rail above the content until the wide breakpoint', () => {
    const split = renderToString(
      <SidebarChrome split scroll="host" fullHeight={false}>
        Rail
      </SidebarChrome>,
    );
    const plain = renderToString(<SidebarChrome>Rail</SidebarChrome>);

    for (const token of [
      'h-[42vh]',
      'min-h-75',
      'shrink-0',
      'border-b',
      'lg:h-full',
      'lg:border-b-0',
      'lg:border-r',
    ]) {
      expect(split).toContain(token);
      expect(plain).not.toContain(token);
    }
  });

  it('owns the rhythm between rows and a quieter hidden list', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <>
          <SidebarList data-testid="plain">rows</SidebarList>
          <SidebarList data-testid="hairline" rowGap="hairline">
            rows
          </SidebarList>
          <SidebarList data-testid="thin" rowGap="thin" quiet>
            rows
          </SidebarList>
        </>,
      );
    });
    const classesOf = (testId: string): string =>
      container.querySelector(`[data-testid="${testId}"]`)?.className ?? '';

    expect(classesOf('plain')).toBe('flex min-w-0 flex-col');
    expect(classesOf('hairline')).toContain('space-y-px');
    expect(classesOf('hairline')).not.toContain('opacity-80');
    expect(classesOf('thin')).toContain('space-y-0.5');
    expect(classesOf('thin')).not.toContain('space-y-px');
    expect(classesOf('thin')).toContain('opacity-80');
    act(() => root.unmount());
  });

  it('frames a selectable group of rows and tints it when it holds the selection', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <>
          <SidebarSection data-testid="plain" collapsible={false}>
            rows
          </SidebarSection>
          <SidebarSection data-testid="group" frame="group" collapsible={false}>
            rows
          </SidebarSection>
          <SidebarSection
            data-testid="selected"
            frame="group"
            selected
            collapsible={false}
          >
            rows
          </SidebarSection>
        </>,
      );
    });
    const classesOf = (testId: string): string =>
      container.querySelector(`[data-testid="${testId}"]`)?.className ?? '';

    expect(classesOf('plain')).not.toContain('rounded-lg');
    expect(classesOf('group')).toContain('rounded-lg');
    expect(classesOf('group')).toContain('pb-1');
    expect(classesOf('group')).not.toContain('bg-fg-primary/[0.03]');
    expect(classesOf('selected')).toContain('bg-fg-primary/[0.03]');
    act(() => root.unmount());
  });

  // A collapsed project is its header alone (32px on desktop): the group's
  // bottom inset belongs to the rows it frames, not to an empty body.
  it('drops the group bottom inset while collapsed', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <SidebarSection
          data-testid="collapsed-group"
          frame="group"
          collapsible={false}
          collapsed
        >
          {null}
        </SidebarSection>,
      );
    });
    const className =
      container.querySelector('[data-testid="collapsed-group"]')?.className ??
      '';
    expect(className).toContain('rounded-lg');
    expect(className.split(' ')).not.toContain('pb-1');
    act(() => root.unmount());
  });

  it('insets the header row and the rows beneath it, and paints the header on the sidebar', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <>
          <SidebarSection data-testid="plain" title="Hidden">
            rows
          </SidebarSection>
          <SidebarSection
            data-testid="inset"
            title="Hidden"
            spacing="inset"
            headerSurface="sidebar"
            headerClassName="z-30"
          >
            rows
          </SidebarSection>
        </>,
      );
    });
    const header = (testId: string): Element | null =>
      container.querySelector(`[data-testid="${testId}"] > div`);
    const content = (testId: string): Element | null =>
      container.querySelector(
        `[data-testid="${testId}"] [data-sidebar-section-content]`,
      );

    expect(header('plain')?.className).not.toContain('px-1');
    expect(header('plain')?.className).not.toContain('bg-sidebar');
    expect(content('plain')?.className ?? '').not.toContain('pb-1');
    expect(header('inset')?.className).toContain('px-1');
    expect(header('inset')?.className).toContain('bg-sidebar');
    expect(header('inset')?.className).toContain('z-30');
    expect(content('inset')?.className).toContain('pb-1');
    act(() => root.unmount());
  });

  it('injects section header slots and forwards section attributes', () => {
    const out = renderToString(
      <SidebarSection
        title="Workspaces"
        icon={<span>icon</span>}
        count={<span>3</span>}
        actions={<button type="button">menu</button>}
        data-testid="section"
        data-onboarding-anchor="workspaces"
      >
        content
      </SidebarSection>,
    );

    expect(out).toContain('Workspaces');
    expect(out).toContain('icon');
    expect(out).toContain('>3<');
    expect(out).toContain('>menu<');
    expect(out).toContain('data-testid="section"');
    expect(out).toContain('data-onboarding-anchor="workspaces"');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('sidebar-fade-presence');
    expect(out).toContain('data-state="open"');
  });

  it('allows a host to relocate the live section header', () => {
    const out = renderToString(
      <SidebarSection
        title="Workspaces"
        renderHeader={(header) => <div data-testid="sticky-host">{header}</div>}
      >
        content
      </SidebarSection>,
    );

    expect(out).toContain('data-testid="sticky-host"');
    expect(out).toContain('Workspaces');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('content');
  });

  it('supports uncontrolled and controlled collapse', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onCollapsedChange = jest.fn<void, [boolean]>();

    act(() => {
      root.render(
        <SidebarSection
          title="Uncontrolled"
          onCollapsedChange={onCollapsedChange}
        >
          child
        </SidebarSection>,
      );
    });
    const uncontrolledButton = container.querySelector('button');
    expect(container.textContent).toContain('child');
    act(() => uncontrolledButton?.click());
    expect(container.querySelector('.sidebar-fade-presence')).toBeNull();
    expect(container.textContent).not.toContain('child');
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    act(() => {
      root.render(
        <SidebarSection
          title="Controlled"
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
        >
          controlled child
        </SidebarSection>,
      );
    });
    const controlledButton = container.querySelector('button');
    act(() => controlledButton?.click());
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    expect(container.textContent).toContain('controlled child');
    act(() => root.unmount());
  });

  it('does not add a disclosure wrapper to non-collapsible sections', () => {
    const out = renderToString(
      <SidebarSection title="Fixed" collapsible={false}>
        child
      </SidebarSection>,
    );

    expect(out).toContain('child');
    expect(out).not.toContain('sidebar-fade-presence');
  });

  it('provides list semantics and row slots, selection and data forwarding', () => {
    const out = renderToString(
      <SidebarList aria-label="Worktrees" data-testid="list">
        <SidebarRowFrame
          selected
          density="touch"
          leading={<span>badge</span>}
          trailing={<button type="button">actions</button>}
          dragHandle={<span>drag</span>}
          data-testid="row"
          data-tour="worktree"
        >
          branch
        </SidebarRowFrame>
      </SidebarList>,
    );

    expect(out).toContain('role="list"');
    expect(out).toContain('role="listitem"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain('data-selected="true"');
    expect(out).toContain('data-sidebar-density="touch"');
    expect(out).toContain('data-tour="worktree"');
    expect(out).toContain('badge');
    expect(out).toContain('actions');
    expect(out).toContain('drag');
    expect(out).toContain('branch');
  });

  it('makes clickable rows keyboard-operable', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const onClick = jest.fn<void, []>();
    act(() => {
      root.render(
        <SidebarRowFrame onClick={onClick}>keyboard row</SidebarRowFrame>,
      );
    });
    const row = container.querySelector('[role="listitem"]');
    expect(row?.getAttribute('tabindex')).toBe('0');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('contains trailing-slot pointer and keyboard activation', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const onClick = jest.fn<void, []>();
    act(() => {
      root.render(
        <SidebarRowFrame
          onClick={onClick}
          trailing={<button type="button">actions</button>}
        >
          row
        </SidebarRowFrame>,
      );
    });
    const button = container.querySelector('button');
    act(() => button?.click());
    expect(onClick).not.toHaveBeenCalled();
    act(() => {
      button?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onClick).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("gives the chrome variant the rail's neutral row vocabulary", () => {
    // Selection is a neutral background, as on every sidebar row; the accent
    // is reserved for things the user can act on.
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <SidebarRowFrame selected onClick={() => {}}>
          chrome row
        </SidebarRowFrame>,
      );
    });
    const className =
      container.querySelector('[role="listitem"]')?.className ?? '';
    expect(className).toContain('rounded-row');
    expect(className).toContain('bg-muted fg-primary');
    expect(className).toContain('focus-ring');
    expect(className).not.toContain('accent');
    expect(className).not.toContain('ring-ring');
    act(() => {
      root.render(
        <SidebarRowFrame onClick={() => {}}>idle row</SidebarRowFrame>,
      );
    });
    expect(container.querySelector('[role="listitem"]')?.className).toContain(
      'hover:bg-subtle',
    );
    act(() => root.unmount());
  });

  it('renders the bare variant as a semantic box without row chrome', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <SidebarRowFrame variant="bare" selected density="touch">
          bare row
        </SidebarRowFrame>,
      );
    });
    const row = container.querySelector('[role="listitem"]');
    expect(row?.tagName).toBe('DIV');
    expect(row?.getAttribute('data-selected')).toBe('true');
    expect(row?.getAttribute('data-sidebar-density')).toBe('touch');
    expect(row?.getAttribute('data-sidebar-variant')).toBe('bare');
    expect(row?.className).toBe('flex w-full min-w-0');
    act(() => root.unmount());
  });
});
