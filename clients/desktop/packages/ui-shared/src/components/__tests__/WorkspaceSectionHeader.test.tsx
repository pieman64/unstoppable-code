/**
 * Server-rendered tests for the shared {@link WorkspaceSectionHeader}.
 * Verifies the single-repo vs multi-repo treatment, warning state, repo
 * count sub-label, and that the slotted drag handle replaces the default
 * badge when provided.
 */
import { renderToString } from 'react-dom/server';
import {
  resolveWorkspaceBadgeBackgroundColor,
  WorkspaceKindBadge,
} from '../WorkspaceKindBadge';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';

describe('WorkspaceSectionHeader', () => {
  it('renders project kind badges with the shared 5px radius', () => {
    const html = renderToString(
      <WorkspaceKindBadge kind="single-repo" color="#38bdf8" />,
    );

    expect(html).toContain('rounded-[calc(var(--radius-md)-3px)]');
    expect(html).toContain('h-4 w-4');
    expect(html).not.toContain('rounded-full');
    expect(html).toContain('background-color:var(--categorical-6)');
    expect(html).toContain('text-white');
  });

  it('renders the cowork badge with the compact filled folder glyph', () => {
    const html = renderToString(
      <WorkspaceKindBadge kind="cowork" color="#38bdf8" />,
    );
    expect(html).toContain('data-glyph="folder-fill1"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('width="14px"');
    expect(html).toContain('background-color:var(--categorical-6)');
    expect(html).toContain('text-white');
  });

  it('renders the multi-repo badge with the shared Lucide folder stack', () => {
    const html = renderToString(
      <WorkspaceKindBadge kind="multi-repo" color="#38bdf8" />,
    );

    expect(html).toContain('data-glyph="folders"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain('="white"');
    expect(html).toContain('text-white');
    expect(html).toContain('class="h-3 w-3"');
  });

  it('renders temporary projects with a dashed neutral badge', () => {
    const html = renderToString(
      <WorkspaceKindBadge kind="multi-repo" temporary color="#38bdf8" />,
    );

    expect(html).toContain('border-color:var(--fg-quaternary)');
    expect(html).toContain('border-style:dashed');
    expect(html).toContain('border-width:1.25px');
    expect(html).toContain('background-color:transparent');
    expect(html).toContain('class="h-3 w-3"');
    // The dashed badge has no colored square to sit on, so it keeps supplying
    // neutral foreground rather than the solid badge's white.
    expect(html).toContain('fg-primary');
    expect(html).not.toContain('text-white');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain('fill="white"');
    expect(html).not.toContain(
      'd="M9 15C7.89543 15 7 14.1046 7 13V12M12.0858 15H15',
    );
  });

  it.each([
    ['#7C3AED', 'var(--categorical-5)'],
    ['#0EA5E9', 'var(--categorical-6)'],
    ['#22C55E', 'var(--categorical-2)'],
    ['#F59E0B', 'var(--categorical-3)'],
    ['#EF4444', 'var(--categorical-4)'],
    ['#14B8A6', 'var(--categorical-1)'],
  ])('maps persisted project color %s to %s', (color, token) => {
    expect(resolveWorkspaceBadgeBackgroundColor(color)).toBe(token);
  });

  it('renders the project name and worktree count', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain('Workspace One');
    expect(html).toContain('>3<');
  });

  it('uses the s text token for the sidebar project label', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain('text-s');
    expect(html).toContain('h-8');
    expect(html).toContain('h-full');
    expect(html).toContain('pl-1.5 pr-1');
    expect(html).not.toContain('px-1.5 h-8');
    expect(html).toContain('rounded-row');
    expect(html).toContain('fg-primary');
    expect(html).toContain('fg-tertiary');
    expect(html).toContain('hover:bg-subtle');
    expect(html).toContain('duration-0');
    expect(html).toContain('transition-colors');
    expect(html).toContain('font-normal');
    expect(html).not.toContain('text-m');
    expect(html).not.toContain('text-3xs');
    expect(html).not.toContain('font-semibold');
    expect(html).not.toContain('font-medium');
    expect(html).not.toContain('font-bold');
  });

  it('lets sidebar headers expand to the full touch-target height', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        touchTarget
        onToggleCollapse={() => {}}
      />,
    );

    expect(html).toContain('min-h-11 py-0 pl-1.5 pr-1');
    expect(html).not.toContain('h-8 py-0 pl-1.5 pr-1');
  });

  it('renders the sidebar counter after hover actions and hides it on interaction', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        showCollapseChevron={false}
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );

    expect(html).toContain('data-testid="workspace-section-counter"');
    expect(html).toContain(
      'hidden shrink-0 items-center gap-0.5 group-hover/sidebar-item:flex group-focus-within/sidebar-item:flex focus-within:flex pointer-coarse:flex',
    );
    // The counter mirrors the trailing controls' visibility on BOTH pointer
    // types: hover-hidden on a fine pointer, and always hidden on a coarse one
    // because those controls are always shown there (CAN-2518).
    expect(html).toContain(
      'ml-auto inline-flex h-5 w-6 shrink-0 items-center justify-end whitespace-nowrap pr-1 text-2xs fg-quaternary mr-0.5 pointer-coarse:w-5 group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden',
    );
    expect(
      html.indexOf('data-testid="workspace-section-counter"'),
    ).toBeLessThan(html.indexOf('Settings for Workspace One'));
    expect(html.indexOf('Settings for Workspace One')).toBeLessThan(
      html.indexOf('Create worktree for Workspace One'),
    );
  });

  // REG-2817. The pip sits at the row's right edge, which is exactly where the
  // deferred action slot goes `absolute inset-y-0 right-0` on reveal — a
  // positioned sibling paints over a non-positioned one in the same stacking
  // context, so without yielding the pip is drawn UNDER the action icons in the
  // one state a user is looking at the row. It takes the same treatment the
  // worktree counter already uses for this collision.
  it('yields the backend pip to the hover action rail instead of sitting under it', () => {
    const deferred = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        backend="cloud"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        deferHoverActions
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(deferred).toContain('data-testid="workspace-backend-pip"');
    expect(deferred).toContain(
      'inline-flex shrink-0 items-center fg-tertiary pointer-fine:group-hover/sidebar-item:hidden pointer-fine:group-focus-within/sidebar-item:hidden',
    );

    // Without the deferred overlay the rail is in flow, so the pip yields on
    // plain hover instead — matching the counter's non-deferred branch.
    const inFlow = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        backend="remote-control"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(inFlow).toContain(
      'inline-flex shrink-0 items-center fg-tertiary group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden',
    );

    // A header with no trailing controls has nothing to collide with, so the
    // pip stays visible throughout.
    const bare = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        backend="cloud"
        worktreeCount={0}
        collapsed={false}
        textScale="sidebar"
        showCollapseChevron={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(bare).toContain('data-testid="workspace-backend-pip"');
    expect(bare).not.toContain('group-hover/sidebar-item:hidden');
  });

  it('puts the counter at the far-right edge and swaps in fine-pointer hover controls', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="unstoppable-domains-website"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        deferHoverActions
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );

    expect(html).toContain(
      'flex shrink-0 items-center gap-0.5 pointer-fine:invisible pointer-fine:absolute pointer-fine:inset-y-0 pointer-fine:right-0 pointer-fine:group-hover/sidebar-item:visible pointer-fine:group-focus-within/sidebar-item:visible',
    );
    // Three controls reveal on hover — settings, add, and the collapse chevron
    // — so the name yields three controls' width (24px each plus the gaps).
    // It yielded two: the name ran under the cog (CAN-3053).
    expect(html).toContain(
      'pointer-fine:group-hover/sidebar-item:pr-19 pointer-fine:group-focus-within/sidebar-item:pr-19',
    );
    expect(html).toContain(
      'min-w-0 truncate text-s font-normal leading-snug fg-primary',
    );
    expect(html).not.toContain(
      'hidden shrink-0 items-center gap-0.5 group-hover/sidebar-item:flex group-focus-within/sidebar-item:flex focus-within:flex pointer-coarse:flex',
    );
    expect(html).toContain(
      'ml-auto inline-flex h-5 w-6 shrink-0 items-center justify-end whitespace-nowrap pr-1 text-2xs fg-quaternary mr-0.5 pointer-coarse:w-5 pointer-fine:group-hover/sidebar-item:hidden pointer-fine:group-focus-within/sidebar-item:hidden',
    );
    expect(html).toContain('data-testid="workspace-section-counter"');
    expect(html).toContain('aria-label="Collapse unstoppable-domains-website"');
    expect(html.indexOf('workspace-section-counter')).toBeLessThan(
      html.indexOf('Settings for unstoppable-domains-website'),
    );
  });

  it('sizes the hover-yield padding to the number of revealed controls', () => {
    // The captured number is the spacing step, a quarter of the pixel value
    // it replaced: step 13 is the old 52px, step 25 the old 100px.
    const padding = (html: string): string | null =>
      html.match(/pointer-fine:group-hover\/sidebar-item:pr-(\d+)/)?.[1] ??
      null;
    const base = {
      name: 'Padded workspace',
      workspaceType: 'single-repo' as const,
      worktreeCount: 3,
      collapsed: false,
      textScale: 'sidebar' as const,
      deferHoverActions: true,
      onToggleCollapse: (): void => {},
    };
    // add + chevron
    expect(
      padding(
        renderToString(<WorkspaceSectionHeader {...base} onAdd={() => {}} />),
      ),
    ).toBe('13');
    // settings + add, no chevron
    expect(
      padding(
        renderToString(
          <WorkspaceSectionHeader
            {...base}
            showCollapseChevron={false}
            onAdd={() => {}}
            onSettings={() => {}}
          />,
        ),
      ),
    ).toBe('13');
    // settings + options + add + chevron
    expect(
      padding(
        renderToString(
          <WorkspaceSectionHeader
            {...base}
            onAdd={() => {}}
            onSettings={() => {}}
            onOptions={() => {}}
          />,
        ),
      ),
    ).toBe('25');
  });

  it('shows an options button that opens the context menu only when a host supplies menu rows', () => {
    const base = {
      name: 'Optioned workspace',
      workspaceType: 'single-repo' as const,
      worktreeCount: 2,
      collapsed: false,
      textScale: 'sidebar' as const,
      onToggleCollapse: (): void => {},
      optionsOpensContextMenu: true,
      optionsButtonDataAttrs: { 'data-testid': 'options' },
    };
    // Nothing to open: no button, and no reserved control width for one.
    expect(renderToString(<WorkspaceSectionHeader {...base} />)).not.toContain(
      'data-testid="options"',
    );
    const withRows = renderToString(
      <WorkspaceSectionHeader
        {...base}
        renderContextMenuItems={() => <span>row</span>}
      />,
    );
    expect(withRows).toContain('data-testid="options"');
    expect(withRows).toContain(
      'aria-label="More actions for Optioned workspace"',
    );
    // A caller's own handler keeps the button regardless of menu rows.
    expect(
      renderToString(<WorkspaceSectionHeader {...base} onOptions={() => {}} />),
    ).toContain('data-testid="options"');
  });

  it('suffixes every fixed test id on a pinned copy and none in flow', () => {
    // Both badge compositions: the built-in badge, and the badge wrapped in
    // the inline disclosure swap (no `onSelectName`, so the name toggles).
    const render = (testIdSuffix?: string, inlineChevron = false): string =>
      renderToString(
        <WorkspaceSectionHeader
          dataTestId="workspace-header"
          name="Pinned workspace"
          workspaceType="single-repo"
          worktreeCount={3}
          collapsed={false}
          textScale="sidebar"
          backend="cloud"
          warning="settings-warning"
          inlineCollapseChevron={inlineChevron}
          onToggleCollapse={() => {}}
          onSettings={() => {}}
          onDelete={() => {}}
          testIdSuffix={testIdSuffix}
        />,
      );
    const fixedIds = [
      'workspace-header',
      'workspace-kind-badge',
      'workspace-backend-pip',
      'workspace-section-counter',
      'workspace-section-actions',
      'workspace-section-remove',
      'workspace-settings-warning-dot',
    ];
    const swapIds = [
      'workspace-icon-disclosure-swap',
      'workspace-section-collapse-chevron',
    ];
    const check = (flow: string, pinned: string, ids: string[]): void => {
      for (const id of ids) {
        // A header is rendered up to four times at once — in flow, in the
        // sticky slot and in both pin bands — so a copy's controls must be
        // addressable apart from the in-flow header's (CAN-3127).
        expect(flow).toContain(`data-testid="${id}"`);
        expect(flow).not.toContain(`data-testid="${id}-pin-top"`);
        expect(pinned).toContain(`data-testid="${id}-pin-top"`);
        expect(pinned).not.toContain(`data-testid="${id}"`);
      }
    };
    check(render(), render('-pin-top'), fixedIds);
    const flowSwap = render(undefined, true);
    const pinnedSwap = render('-pin-top', true);
    expect(flowSwap).toContain('data-testid="workspace-icon-disclosure-swap"');
    check(flowSwap, pinnedSwap, [...fixedIds, ...swapIds]);
  });

  it('keeps deferred controls pinned beside the counter on coarse pointers', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Touch workspace"
        workspaceType="single-repo"
        worktreeCount={3}
        collapsed={false}
        textScale="sidebar"
        deferHoverActions
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );

    expect(html).toContain(
      'flex shrink-0 items-center gap-0.5 pointer-fine:invisible pointer-fine:absolute pointer-fine:inset-y-0 pointer-fine:right-0 pointer-fine:group-hover/sidebar-item:visible pointer-fine:group-focus-within/sidebar-item:visible pointer-fine:focus-within:visible pointer-coarse:gap-0',
    );
    expect(html).toContain(
      'pointer-coarse:w-5 pointer-fine:group-hover/sidebar-item:hidden',
    );
    expect(html).not.toContain('pointer-coarse:hidden');
    expect(html).toContain('aria-label="Collapse Touch workspace"');
  });

  describe('pinned to top', () => {
    const renderPinned = (
      props: Partial<Parameters<typeof WorkspaceSectionHeader>[0]> = {},
    ): string =>
      renderToString(
        <WorkspaceSectionHeader
          name="Pinned project"
          workspaceType="single-repo"
          worktreeCount={3}
          collapsed={false}
          textScale="sidebar"
          pinnedToTop
          onToggleCollapse={() => {}}
          onAdd={() => {}}
          onSettings={() => {}}
          {...props}
        />,
      );

    it('shows the pin just left of the count, hidden with it', () => {
      const html = renderPinned();
      const pin = html.indexOf('data-testid="workspace-section-pinned-badge"');
      const counter = html.indexOf('data-testid="workspace-section-counter"');
      expect(pin).toBeGreaterThan(-1);
      expect(counter).toBeGreaterThan(pin);
      expect(html).toContain('aria-label="Pinned"');
      // One trailing group owns the auto margin, so the pin and the count
      // stay together at the trailing edge.
      expect(html).toContain('ml-auto flex shrink-0 items-center');
      // The pin yields to the trailing controls exactly as the count does.
      const pinTag = html.slice(
        html.lastIndexOf('<span', pin),
        html.indexOf('>', pin),
      );
      expect(pinTag).toContain(
        'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden',
      );
      expect(pinTag).not.toContain('opacity-0');
    });

    it('keeps the pin when the count is not shown', () => {
      const html = renderPinned({ countPresentation: 'collapsed-only' });
      expect(html).toContain('data-testid="workspace-section-pinned-badge"');
      expect(html).not.toContain('data-testid="workspace-section-counter"');
    });

    it('announces the pinned state in the primary button name', () => {
      expect(renderPinned()).toContain(
        'aria-label="Collapse Pinned project, Pinned"',
      );
      expect(renderPinned({ onSelectName: () => {} })).toContain(
        'aria-label="Select Pinned project, Pinned"',
      );
    });

    it('suffixes the pin for header copies', () => {
      const html = renderPinned({ testIdSuffix: '-pin-top' });
      expect(html).toContain('workspace-section-pinned-badge-pin-top');
    });

    it('renders no pin and the bare counter when unpinned', () => {
      const html = renderPinned({ pinnedToTop: false });
      expect(html).not.toContain('workspace-section-pinned-badge');
      expect(html).not.toContain('ml-auto flex shrink-0 items-center');
    });
  });

  it('does not render a project counter when there are no worktrees', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Empty workspace"
        workspaceType="single-repo"
        worktreeCount={0}
        collapsed={false}
        textScale="sidebar"
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
      />,
    );

    expect(html).not.toContain('data-testid="workspace-section-counter"');
  });

  it('keeps the counter visible on hover when the row has no actions', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Disclosure"
        workspaceType="single-repo"
        worktreeCount={2}
        collapsed
        textScale="sidebar"
        showCollapseChevron={false}
        onToggleCollapse={() => {}}
        primaryButtonDataAttrs={{ 'data-testid': 'disclosure-toggle' }}
      />,
    );

    expect(html).toContain('data-testid="disclosure-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('group-hover/sidebar-item:hidden');
    expect(html).not.toContain('group-focus-within/sidebar-item:hidden');
  });

  it('uses a fallback label when the project name is missing at runtime', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name={undefined as unknown as string}
        workspaceType="single-repo"
        worktreeCount={0}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(html).toContain('Untitled project');
    expect(html).toContain('Settings for Untitled project');
  });

  it('renders the single-repo icon badge for single-repo projects', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={2}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    // Single-repo: the Lucide folder glyph is rendered inside the
    // leading badge (no first-letter avatar).
    expect(html).toContain('data-glyph="folder-fill1"');
    expect(html).toContain('width="14px"');
    expect(html).toContain('height="14px"');
    expect(html).toContain('class="h-3 w-3"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('text-white');
  });

  // CAN-3053 regression: the shared rail replaced desktop's `ProjectIcon`
  // and dropped the GitHub owner avatar every single-repo header used to wear.
  it('overlays the GitHub owner avatar on a single-repo project badge', () => {
    const avatarUrl = 'https://github.com/unstoppabledomains.png?size=32';
    const render = (testIdSuffix?: string, inlineChevron = false): string =>
      renderToString(
        <WorkspaceSectionHeader
          name="canopy"
          workspaceType="single-repo"
          avatarUrl={avatarUrl}
          worktreeCount={2}
          collapsed={false}
          textScale="sidebar"
          inlineCollapseChevron={inlineChevron}
          onToggleCollapse={() => {}}
          testIdSuffix={testIdSuffix}
        />,
      );

    for (const html of [render(), render(undefined, true)]) {
      expect(html).toContain(`src="${avatarUrl}"`);
      expect(html).toContain('referrerPolicy="no-referrer"');
      expect(html).toContain('data-testid="workspace-owner-avatar"');
      // The kind badge stays underneath as the load/error fallback.
      expect(html).toContain('data-testid="workspace-kind-badge"');
    }
    expect(render('-pin-top')).toContain(
      'data-testid="workspace-owner-avatar-pin-top"',
    );
  });

  it.each(['multi-repo', 'cowork'] as const)(
    'keeps the plain %s kind badge even when an avatar URL is supplied',
    (workspaceType) => {
      const html = renderToString(
        <WorkspaceSectionHeader
          name="Project"
          workspaceType={workspaceType}
          avatarUrl="https://github.com/acme.png?size=32"
          worktreeCount={1}
          collapsed={false}
          onToggleCollapse={() => {}}
        />,
      );
      expect(html).not.toContain('<img');
      expect(html).toContain('data-testid="workspace-kind-badge"');
    },
  );

  it('renders the multi-repo icon and repo sub-label for multi-repo projects', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Multi Workspace"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={4}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    // The sub-label is rendered as a single text node (no JSX interleaving).
    expect(html).toContain('>4 repos<');
    expect(html).toContain('fg-info');
  });

  it('renders the singular repo sub-label when repoCount is 1', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Multi"
        workspaceType="multi-repo"
        worktreeCount={1}
        repoCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain('>1 repo<');
    expect(html).not.toContain('>1 repos<');
  });

  it('shows the settings button with an accent status dot when warning is set', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        warning="settings-warning"
        onToggleCollapse={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(html).toContain('Settings for W');
    expect(html).toContain('data-testid="workspace-settings-warning-dot"');
    expect(html).toContain('bg-fg-blue');
    expect(html).toContain('fg-tertiary');
    expect(html).not.toContain('fg-warning');
  });

  it('keeps the settings button hidden until hover when warning is null', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        warning={null}
        onToggleCollapse={() => {}}
        onSettings={() => {}}
      />,
    );
    // Settings stays invisible and non-interactive at rest, then appears when
    // the fixed-height workspace header itself is hovered or focused.
    expect(html).toContain('Settings for W');
    expect(html).toContain('opacity-0');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('group-hover/sidebar-item:opacity-100');
    expect(html).toContain('group-focus-within/sidebar-item:opacity-100');
  });

  it('omits the settings button entirely when onSettings is not supplied', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).not.toContain('Preferences');
  });

  it('omits the add button when onAdd is not supplied', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).not.toContain('Create worktree for W');
  });

  it('renders the add button when onAdd is supplied', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(html).toContain('Create worktree for W');
  });

  it('uses chat terminology for a cowork project add button', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Cloud workspace"
        workspaceType="cowork"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        onAdd={() => {}}
      />,
    );

    expect(html).toContain('Create chat for Cloud workspace');
    expect(html).not.toContain('Create worktree for Cloud workspace');
  });

  it('uses chat terminology for an empty cowork project', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Cloud workspace"
        workspaceType="cowork"
        worktreeCount={0}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    expect(html).toContain('Cloud workspace has no chats');
    expect(html).not.toContain('Cloud workspace has no worktrees');
  });

  it('keeps a disabled add button visible without hover', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="multi-repo"
        worktreeCount={0}
        collapsed={false}
        addDisabled
        addDisabledTitle="Add repos first"
        onToggleCollapse={() => {}}
        onAdd={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Create worktree for W"');
    expect(html).toContain('disabled=""');
    expect(html).toContain(
      '<span class="relative inline-flex shrink-0 "><button type="button" aria-label="Create worktree for W"',
    );
  });

  it('renders the supplied dragHandleSlot instead of the default badge', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        dragHandleSlot={<span data-testid="custom-drag-handle">drag</span>}
      />,
    );
    expect(html).toContain('data-testid="custom-drag-handle"');
    expect(html).not.toContain('Select W');
  });

  it('keeps the default cursor on the draggable project badge', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    expect(html).toContain('cursor-default');
    expect(html).not.toContain('cursor-grab');
    expect(html).not.toContain('cursor-grabbing');
  });

  it('keeps the default cursor on a draggable project label', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        primaryButtonDataAttrs={{
          'data-workspace-drag-activator': 'label',
        }}
      />,
    );

    const primaryClass = html.match(
      /data-workspace-drag-activator="label" class="([^"]+)"/,
    )?.[1];
    expect(primaryClass?.split(' ')).toContain('cursor-default');
  });

  it('keeps project selection on the name when a drag handle replaces the badge', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        onSelectName={() => {}}
        touchTarget
        dragHandleSlot={
          <button type="button" aria-label="Reorder W">
            drag
          </button>
        }
      />,
    );
    expect(html).toContain('aria-label="Select W"');
    expect(html).toContain('aria-label="Reorder W"');
    expect(html).toContain('aria-label="Collapse W"');
    expect(html).toContain('min-h-11');
    expect(html).toContain('items-center justify-center');
    expect(html).toContain('pointer-coarse:min-w-11');
  });

  it('shows the collapsed chevron rotation when collapsed', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={2}
        collapsed
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain('-rotate-90');
    expect(html).not.toContain('transition-transform');
  });

  it('can hide the collapse chevron while keeping the name toggle', () => {
    const html = renderToString(
      <WorkspaceSectionHeader
        name="W"
        workspaceType="single-repo"
        worktreeCount={2}
        collapsed={false}
        showCollapseChevron={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Collapse W"');
    expect(html).not.toContain('transition-transform');
  });

  describe('repo-name tooltip', () => {
    it('renders the repo count as a focusable tooltip trigger and exposes repo names via aria-label', () => {
      const html = renderToString(
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
      // Trigger text remains `<N> repos`.
      expect(html).toContain('>3 repos<');
      // The trigger is a native button, so keyboard semantics come from the
      // element instead of ARIA role/tabIndex shims.
      expect(html).toContain('<button type="button"');
      expect(html).not.toContain('role="button"');
      // The trigger's aria-label exposes every repo name to assistive tech;
      // visible tooltip content is mounted in a portal on hover/focus and
      // therefore is not present in the initial SSR markup.
      expect(html).toContain(
        'aria-label="Repositories: Repo A, Repo B, Repo C"',
      );
      expect(html).not.toContain('Repositories<');
    });

    it('keeps the plain count visible when repoNames is omitted', () => {
      const html = renderToString(
        <WorkspaceSectionHeader
          name="Plain"
          workspaceType="multi-repo"
          worktreeCount={1}
          repoCount={2}
          collapsed={false}
          onToggleCollapse={() => {}}
        />,
      );
      expect(html).toContain('>2 repos<');
      // No tooltip elements without repoNames.
      expect(html).not.toContain('aria-label="Repositories');
      expect(html).not.toContain('Repositories<');
    });

    it('preserves the singular `repo` label inside the tooltip trigger', () => {
      const html = renderToString(
        <WorkspaceSectionHeader
          name="Single"
          workspaceType="multi-repo"
          worktreeCount={1}
          repoCount={1}
          repoNames={['Solo Repo']}
          collapsed={false}
          onToggleCollapse={() => {}}
        />,
      );
      expect(html).toContain('>1 repo<');
      expect(html).not.toContain('>1 repos<');
      // Singular repo name still exposed via aria-label for screen readers.
      expect(html).toContain('aria-label="Repositories: Solo Repo"');
    });
  });

  it('keeps hover-hidden controls reachable on coarse-pointer (touch) devices', () => {
    // Hover-revealed controls need a display and target-size escape hatch on
    // touch, where hover does not exist (CAN-1268).
    const html = renderToString(
      <WorkspaceSectionHeader
        name="Workspace One"
        workspaceType="single-repo"
        worktreeCount={2}
        collapsed={false}
        onToggleCollapse={() => {}}
        onAdd={() => {}}
        onSettings={() => {}}
        onDelete={() => {}}
      />,
    );
    const visibleMatches = html.match(/pointer-coarse:opacity-100/g) ?? [];
    const interactiveMatches =
      html.match(/pointer-coarse:pointer-events-auto/g) ?? [];
    // Each hover-hidden control (delete, settings, add) has a reveal wrapper
    // and a coarse-pointer-visible button inside it.
    expect(visibleMatches.length).toBe(6);
    expect(interactiveMatches.length).toBe(3);
    const touchHeightMatches = html.match(/pointer-coarse:min-h-11/g) ?? [];
    const touchWidthMatches = html.match(/pointer-coarse:min-w-11/g) ?? [];
    expect(touchHeightMatches.length).toBe(4);
    expect(touchWidthMatches.length).toBe(4);
    // Every 44px-tall touch button must center its icon; without
    // `items-center justify-center` the icon pins to the top of the taller
    // coarse-pointer hit area (observed on mobile portal, +/gear shifted up).
    const touchButtonClasses = (html.match(/class="[^"]*"/g) ?? []).filter(
      (cls) => cls.includes('pointer-coarse:min-h-11'),
    );
    expect(touchButtonClasses.length).toBe(4);
    for (const cls of touchButtonClasses) {
      expect(cls).toContain('items-center');
      expect(cls).toContain('justify-center');
    }
  });

  it('switches the removal control to the archive treatment on request', () => {
    const deleteHtml = renderToString(
      <WorkspaceSectionHeader
        name="Cloud"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(deleteHtml).toContain('aria-label="Delete Cloud"');
    expect(deleteHtml).not.toContain('Archive project');

    const archiveHtml = renderToString(
      <WorkspaceSectionHeader
        name="Cloud"
        workspaceType="single-repo"
        worktreeCount={1}
        collapsed={false}
        onToggleCollapse={() => {}}
        onDelete={() => {}}
        removalPresentation="archive"
      />,
    );
    expect(archiveHtml).toContain('aria-label="Archive project Cloud"');
    expect(archiveHtml).not.toContain('aria-label="Delete Cloud"');
    // Archive is reversible, so it must not carry the destructive tone.
    expect(archiveHtml).not.toContain('hover:fg-destructive');
  });
});
