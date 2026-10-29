/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const GLOBALS_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'styles', 'globals.css'),
  'utf-8',
);
const WORKSPACES_SOURCE = readFileSync(
  join(__dirname, '..', 'SidebarWorkspacesSection.tsx'),
  'utf-8',
);
const PROJECT_SECTION_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'worktree', 'ProjectSection.tsx'),
  'utf-8',
);
const COWORK_WORKSPACE_SOURCE = readFileSync(
  join(__dirname, '..', 'SidebarCoworkWorkspaceRow.tsx'),
  'utf-8',
);
const WORK_ENTRY_ROW_SOURCE = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/WorkEntryRow.tsx',
  ),
  'utf-8',
);
const CUSTOMIZE_SIDEBAR_SOURCE = readFileSync(
  join(__dirname, '..', 'CustomizeSidebarModal.tsx'),
  'utf-8',
);
const PROJECT_HEADER_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'worktree', 'ProjectHeader.tsx'),
  'utf-8',
);
const WORKTREE_ROW_SOURCE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ui-shared',
    'src',
    'components',
    'WorktreeRow.tsx',
  ),
  'utf-8',
);
const WORKSPACE_HEADER_SOURCE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ui-shared',
    'src',
    'components',
    'WorkspaceSectionHeader.tsx',
  ),
  'utf-8',
);

describe('main and settings sidebar transition', () => {
  it('slides sidebar pages while counter-moving stationary titlebar controls', () => {
    const contentTransitionRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-content,\s*\.settings-sidebar-content \{([\s\S]*?)\}/,
    )?.[1];
    const inactiveAppSidebarRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-content\[data-page-active='false'\] \{([\s\S]*?)\}/,
    )?.[1];
    const inactiveSettingsSidebarRule = GLOBALS_SOURCE.match(
      /\.settings-page-overlay\[data-open='false'\] \.settings-sidebar-content \{([\s\S]*?)\}/,
    )?.[1];
    const stationaryControlRule = GLOBALS_SOURCE.match(
      /\.sidebar-page-stationary-control \{([\s\S]*?)\}/,
    )?.[1];
    const inactiveStationaryControlRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-content\[data-page-active='false'\]\s+\.sidebar-page-stationary-control \{([\s\S]*?)\}/,
    )?.[1];

    expect(contentTransitionRule).toContain(
      'transform var(--page-slide-dur) var(--page-slide-ease)',
    );
    expect(contentTransitionRule).toContain(
      'var(--page-fade-dur), var(--page-slide-dur) !important',
    );
    expect(inactiveAppSidebarRule).toContain(
      'calc(var(--page-slide-distance) * -1 * var(--page-exit-enabled))',
    );
    expect(inactiveSettingsSidebarRule).toContain(
      'calc(var(--page-slide-distance) * var(--page-exit-enabled))',
    );
    expect(stationaryControlRule).toContain(
      'transform var(--page-slide-dur) var(--page-slide-ease)',
    );
    expect(inactiveStationaryControlRule).toContain(
      'calc(var(--page-slide-distance) * var(--page-exit-enabled))',
    );
  });
});

describe('sticky band divider', () => {
  it('is not rendered at all', () => {
    // The rule marked the band's bottom edge back when the band was
    // transparent and the edge was otherwise invisible. The band paints now,
    // so the surface change IS the edge — and the rule only appeared for the
    // few scroll positions between fading in and being covered by the band,
    // which read as a line flickering in and out.
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-sticky-workspaces-divider');
  });
});

describe('sticky Projects occlusion', () => {
  it('fades a row out as a unit before any of it goes under the band', () => {
    // CAN-3126, the part a gradient cannot fix. Anything above the band's
    // bottom edge is gone — the opaque band covers it whether or not a clip
    // removes it — so a two-line row caught half-way shows its branch name
    // with no title above it. Chats never showed this only because its rows
    // are a single line.
    //
    // So each row carries its own view-progress timeline, inset by the band's
    // depth, and its CONTENTS fade together over the row-height of travel
    // just before it goes under. A row is then always either wholly below the
    // band or wholly invisible, and its two lines always share one opacity.
    const rowRule = GLOBALS_SOURCE.match(
      /\.sidebar-workspaces-rows-clip \[data-worktree-id\] \{([\s\S]*?)\n\}/,
    )?.[1];
    const contentsSelector = GLOBALS_SOURCE.match(
      /\.sidebar-workspaces-rows-clip\s+\[data-worktree-id\]\s+> ([^{]*?)\s*\{\s*\n\s*animation-name: sidebar-workspace-row-band-fade;/,
    )?.[1];
    const contentsRule = GLOBALS_SOURCE.match(
      /\.sidebar-workspaces-rows-clip\s+\[data-worktree-id\]\s+> [^{]*?\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(rowRule).toBeDefined();
    expect(contentsRule).toBeDefined();
    // Both of the row's absolutely positioned overlays are exempt: the action
    // chip and the status rail. Each hides itself with its OWN `opacity` — the
    // chip so a row drops its hover actions while its ••• menu is open, the
    // rail so its status indicator yields to those actions on hover/focus. A
    // CSS animation outranks every normal declaration, so
    // `animation-fill-mode: both` holding this keyframe's `opacity: 1` outside
    // the fade range pinned both visible and made those declarations inert.
    // Matching `> *` again, or dropping either exemption, silently brings the
    // cascade bug back.
    //
    // Assert the STRUCTURE, not just the substrings. A selector that merely
    // mentions both ids can still animate the rail — moving one outside the
    // `:not()` turns the rule into a selector LIST whose second branch matches
    // the rail directly:
    //   > *:not([...action-chip]), [...status-rail]
    // That contains `:not(` and both ids and would satisfy a `toContain` pair
    // while doing the exact opposite. So: the compound must be a single `> *`
    // with one `:not()`, and both ids must be arguments of that one `:not()`.
    const notArgument = contentsSelector?.match(
      /^\*:not\(\s*([\s\S]*?)\s*\)$/,
    )?.[1];
    expect(notArgument).toBeDefined();
    expect(
      notArgument
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort(),
    ).toEqual([
      "[data-testid^='worktree-row-action-chip']",
      "[data-testid^='worktree-row-status-rail']",
    ]);
    expect(rowRule).toContain('view-timeline-name: --sidebar-workspace-row');
    // The band's depth, from the same terms the clip and the divider use.
    for (const term of [
      '--sidebar-workspace-header-top',
      '--sidebar-external-projects-header-height',
      '--sidebar-selected-pin-top-height',
      '--sidebar-workspaces-slot-height',
    ]) {
      expect(rowRule).toContain(term);
    }
    expect(contentsRule).toContain(
      'animation-timeline: --sidebar-workspace-row',
    );
    // The range is the row's passage under the band: `exit 0%` is its top
    // edge reaching the band's bottom, `exit 100%` its own bottom edge. A row
    // clear of the band is therefore untouched — running the fade BEFORE the
    // passage instead (`exit -100% exit 0%`) dimmed rows that were still
    // completely on screen.
    expect(contentsRule).toContain('animation-range: exit 0% exit 100%');
    // On the contents, never the row: a row's own `opacity: 0` is how a
    // pinned copy hides its in-flow original, and an animation on the row
    // would override it and paint the duplicate.
    expect(rowRule).not.toContain('animation-name');

    // …and it must reach ZERO before the row is far enough under to show a
    // branch name with no title above it. A row's title ends ~56% of the way
    // down it, so the fade has to be finished by then; a plain linear fade
    // across the whole passage is still visible at 56% and shows exactly the
    // pairing this is here to prevent.
    const fadeKeyframes = GLOBALS_SOURCE.match(
      /@keyframes sidebar-workspace-row-band-fade \{([\s\S]*?)\n\}/,
    )?.[1];
    const zeroAt = fadeKeyframes?.match(/(\d+)% \{\s*opacity: 0;/);
    expect(zeroAt).not.toBeNull();
    expect(Number.parseInt(zeroAt?.[1] ?? '100', 10)).toBeLessThanOrEqual(56);
  });

  it('does not animate a mask on the rows layer', () => {
    // `mask-image` is not compositor-animated, so interpolating it on every
    // scroll frame repaints the whole list — visibly dropping frames while
    // scrolling the sidebar. It was there to soften the cut; rows fade
    // themselves as a unit now, which makes it redundant as well as costly.
    const rule = GLOBALS_SOURCE.match(
      /\.sidebar-workspaces-rows-clip \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(rule).toBeDefined();
    // Declarations only — the comment explaining WHY the mask is gone names
    // the property, and would otherwise fail this assertion.
    const declarations = (rule ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toContain('mask-image');
    expect(declarations).toContain('will-change: clip-path;');
    // The cut itself stays: it is the backstop behind the fade, and it is
    // what occludes project HEADERS, which have no fade of their own.
    expect(rule).toContain(
      'var(--sidebar-workspaces-occlusion-top, -100000px)',
    );
  });

  it('paints the sticky band and clips the rows beneath it', () => {
    const workspacesClipRule = GLOBALS_SOURCE.match(
      /\.sidebar-workspaces-rows-clip \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedPinTopRule = GLOBALS_SOURCE.match(
      /\.sidebar-selected-pin-top \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedPinBottomRule = GLOBALS_SOURCE.match(
      /\.sidebar-selected-pin-bottom \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedPinSurfaceRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-material \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedPinPreviewSurfaceRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-material\.app-sidebar-preview-surface \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedPinTranslucentSurfaceRule = GLOBALS_SOURCE.match(
      /html\[data-platform='darwin'\]\[data-sidebar-appearance='translucent'\]\s+\.app-sidebar-material:not\(\.app-sidebar-preview-surface\) \{([\s\S]*?)\n\}/,
    )?.[1];
    const newTaskMaskRule = GLOBALS_SOURCE.match(
      /\.sidebar-new-task-scroll-mask \{([\s\S]*?)\n\}/,
    )?.[1];
    // The bottom fade only applies while the footer banner stack has content;
    // with no banner the list meets the account divider without a fade.
    const bottomMaskRule = GLOBALS_SOURCE.match(
      /\.app-sidebar-material:has\(\s*\[data-sidebar-footer-banners\]:not\(:empty\)\s*\)\s*\.sidebar-scroll-mask \{([\s\S]*?)\n\}/,
    )?.[1];
    const workspaceHeaderRule = GLOBALS_SOURCE.match(
      /\.sidebar-workspace-sticky-header \{([\s\S]*?)\n\}/,
    )?.[1];
    const selectedFlowHiddenRule = GLOBALS_SOURCE.match(
      /\[data-sidebar-selected-pin-flow-hidden='true'\][\s\S]*?\{([\s\S]*?)\n\}/,
    )?.[1];
    const workspaceSlotRule = GLOBALS_SOURCE.match(
      /\.sidebar-sticky-workspace-slot \{([\s\S]*?)\n\}/,
    )?.[1];
    const clipKeyframesRule = GLOBALS_SOURCE.match(
      /@keyframes sidebar-workspace-flow-clip \{([\s\S]*?)\n\}/,
    )?.[1];

    // The clip is composed from the animated length, whose fallback is deeply
    // negative — so it clips nothing until the rail publishes real geometry,
    // which is what the old static `clip-path: none` reset stood for.
    expect(workspacesClipRule).toContain(
      'var(--sidebar-workspaces-occlusion-top, -100000px)',
    );
    expect(workspacesClipRule).toContain('translate: 0 0');
    // The occlusion clip must be a pure function of the scroll offset:
    // always animating over the full scroll range, never gated on a
    // per-scroll JS attribute write (composited flings paint frames before
    // main-thread scroll handlers run).
    expect(workspacesClipRule).toContain(
      'animation-name: sidebar-workspace-flow-clip',
    );
    expect(workspacesClipRule).toContain(
      'animation-timeline: scroll(nearest block)',
    );
    expect(workspacesClipRule).not.toContain('animation-range-start');
    expect(workspacesClipRule).toContain('will-change: clip-path;');
    expect(workspacesClipRule).not.toContain('background:');
    expect(selectedPinSurfaceRule).toContain(
      '--sidebar-selected-pin-surface: var(--bg-sidebar)',
    );
    expect(selectedPinPreviewSurfaceRule).toContain(
      '--sidebar-selected-pin-surface: var(--bg-tertiary)',
    );
    // The translucent band PAINTS (CAN-3126), as the web portal's does. It
    // used to stay transparent so the window material's tint could not
    // composite twice, which left the clip as the only occlusion — and with
    // the clip line now sitting ON the band's bottom edge, a transparent band
    // lets rows render straight through the headers.
    expect(selectedPinTranslucentSurfaceRule).toContain(
      '--sidebar-selected-pin-surface: var(--bg-sidebar)',
    );
    expect(selectedPinTranslucentSurfaceRule).not.toContain('color-mix(');
    expect(selectedPinTopRule).toContain(
      'background-color: var(--sidebar-selected-pin-surface)',
    );
    expect(selectedPinBottomRule).toContain(
      'background-color: var(--sidebar-selected-pin-surface)',
    );
    // The selected chat's copy under the Chats header shares that surface.
    expect(
      GLOBALS_SOURCE.match(
        /\n\.sidebar-chats-selected-pin-row \{([\s\S]*?)\n\}/,
      )?.[1],
    ).toContain('background-color: var(--sidebar-selected-pin-surface)');
    // Over the 56% translucent material a solid `--bg-sidebar` fill reads as a
    // black block, so sticky headers and pin bands occlude with a frosted
    // backdrop there instead — except under reduced transparency, where the
    // material itself is opaque and the solid fill matches it.
    const translucentStickySurfaceRules: string[] = (
      GLOBALS_SOURCE.match(
        /html\[data-platform='darwin'\]\[data-sidebar-appearance='translucent'\]\s+\.app-sidebar-material:not\(\.app-sidebar-preview-surface\)\s+:is\(\s*\.bg-sidebar\.sticky,\s*\.sidebar-sticky-workspace-slot,\s*\.sidebar-selected-pin-top,\s*\.sidebar-selected-pin-bottom,\s*\.sidebar-chats-selected-pin-row\s*\) \{([\s\S]*?)\n\s*\}/g,
      ) ?? []
    ).map((rule) => rule.slice(rule.indexOf('{') + 1));
    expect(translucentStickySurfaceRules).toHaveLength(2);
    expect(translucentStickySurfaceRules[0]).toContain(
      'background: transparent',
    );
    expect(translucentStickySurfaceRules[0]).toContain(
      'backdrop-filter: blur(24px)',
    );
    expect(translucentStickySurfaceRules[1]).toContain(
      'background: var(--bg-sidebar)',
    );
    expect(translucentStickySurfaceRules[1]).toContain('backdrop-filter: none');
    expect(GLOBALS_SOURCE).not.toContain(
      ".sidebar-workspaces-rows-clip[data-sidebar-workspace-sticky-active='true']",
    );
    // Full-range interpolation: inert before the sticky threshold, tracking
    // scroll 1:1 beyond it, and clipping nothing while the geometry vars are
    // unpublished. The selected-item pin vars default to 0px so both bands are
    // identical to the pre-pin behavior whenever nothing is pinned.
    //
    // The band is DERIVED rather than the old flat 40px (CAN-3126). That
    // constant assumed a band depth the rail does not have: the clip cut ~19px
    // above the slot's real bottom, so the row straddling the line lost its
    // title while its branch name survived below — the orphaned subtitle.
    // Every term here is a property the rail already keeps current, so the clip
    // line tracks the band without being re-measured; measuring it per frame is
    // what the scroll hot path forbids.
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspace-header-top, 0px)',
    );
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-flow-top, 0px)',
    );
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-selected-pin-top-clip, 0px)',
    );
    // The external-Projects-header term IS required here, unlike in the old
    // fixed-band form where it double-counted a header already accounted for
    // by the flow layer's own offset. This expression computes the band's
    // ABSOLUTE bottom from the controls' seat, and on the shared surface that
    // seat is followed by a 32px Projects header before the slot. Dropping it
    // put the clip exactly one header above the band.
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-external-projects-header-height, 0px)',
    );
    // Clamped so a bad measurement cannot clip the list away, which an earlier
    // attempt at this did.
    expect(clipKeyframesRule).toContain('clamp(');
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-clip-start, 100000px)',
    );
    // Same band on the `to` frame; only the travel term differs.
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-clip-distance, -100000px)',
    );
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-clip-distance, -100000px)',
    );
    // Bottom band: holds the clip line at the viewport's bottom edge (minus
    // the active bottom pin group) at every offset, deeply negative while
    // unpublished so nothing clips.
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-bottom-clip-start, -100000px) +',
    );
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-workspaces-clip-total, 0px) +',
    );
    expect(clipKeyframesRule).toContain(
      'var(--sidebar-selected-pin-bottom-clip, 0px)',
    );
    expect(GLOBALS_SOURCE).not.toContain(
      '.sidebar-sticky-workspace-slot[data-sidebar-workspace-drag-active]',
    );
    expect(workspaceHeaderRule).toContain('position: relative');
    expect(workspaceHeaderRule).not.toContain('position: sticky');
    expect(workspaceHeaderRule).not.toContain('transform');
    expect(workspaceSlotRule).toContain('position: absolute');
    // The slot seat starts at the band's bottom edge and shifts below anything
    // else occupying it: the selected-item pin group while active, and a
    // Projects header the HOST renders below the band rather than inside it
    // (the shared sidebar surface does). Both vars default to 0px, restoring
    // the plain `top: 100%` seat for the legacy rail.
    //
    // Asserted as parts rather than one formatted string: Prettier rewraps a
    // multi-term `calc`, and a test that breaks on reflowing is a test that
    // gets loosened rather than read.
    expect(workspaceSlotRule).toMatch(/top:\s*calc\(/);
    expect(workspaceSlotRule).toContain('100%');
    expect(workspaceSlotRule).toContain(
      'var(--sidebar-external-projects-header-height, 0px)',
    );
    expect(workspaceSlotRule).toContain(
      'var(--sidebar-selected-pin-top-height, 0px)',
    );
    expect(workspaceSlotRule).toContain('height: 2rem');
    expect(workspaceSlotRule).toContain(
      'background: var(--sidebar-selected-pin-surface)',
    );
    expect(workspaceSlotRule).not.toContain('transform');
    expect(workspaceSlotRule).not.toContain('transition');
    expect(selectedFlowHiddenRule).toContain('opacity: 0');
    expect(GLOBALS_SOURCE).not.toContain(
      '.sidebar-sticky-workspace-controls::before',
    );
    expect(newTaskMaskRule).toContain('--sidebar-new-task-mask-start: -12px');
    expect(newTaskMaskRule).toContain('--sidebar-new-task-mask-end: 0px');
    expect(newTaskMaskRule).toContain(
      'transparent var(--sidebar-new-task-mask-start)',
    );
    expect(newTaskMaskRule).toContain('black var(--sidebar-new-task-mask-end)');
    expect(newTaskMaskRule).not.toContain('background');
    expect(bottomMaskRule).toContain('black calc(100% - 12px)');
    expect(bottomMaskRule).toContain('transparent 100%');
    // No unconditional mask rule may exist alongside the banner-scoped one.
    expect(GLOBALS_SOURCE).not.toMatch(/^\.sidebar-scroll-mask \{/m);
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-primary-scroll-mask');
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-workspaces-scroll-mask');
    expect(GLOBALS_SOURCE).not.toContain('data-workspaces-header-sticky');
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-sticky-header-overlay');
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-scroll-top-gradient');
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-nav-scroll-mask');
    expect(GLOBALS_SOURCE).not.toContain('.sidebar-scroll-top-mask');
  });

  it('does not add an opaque sidebar surface to the sticky group', () => {
    expect(GLOBALS_SOURCE).not.toMatch(
      /\.sidebar-sticky-workspace-controls[^{]*\{[^}]*background/s,
    );
  });

  it('matches task-row drag geometry instead of sorting expanded sections', () => {
    expect(WORKSPACES_SOURCE).toContain(
      'const staticListSortingStrategy: SortingStrategy = () => null',
    );
    expect(WORKSPACES_SOURCE).toContain('strategy={staticListSortingStrategy}');
    expect(WORKSPACES_SOURCE).not.toContain(
      'strategy={verticalListSortingStrategy}',
    );
    expect(WORKSPACES_SOURCE).toContain('<DragOverlay dropAnimation={null}>');
    for (const source of [PROJECT_SECTION_SOURCE, COWORK_WORKSPACE_SOURCE]) {
      expect(source).toContain('data-sidebar-workspace-sortable-header');
      expect(source).toContain("'opacity-60'");
      expect(source).toContain('data-testid="workspace-drop-indicator"');
      expect(source).toContain('h-0.5 rounded-full bg-accent');
      expect(source).not.toContain(
        "workspaceDragActive || isDragging ? 'opacity-0'",
      );
    }
    // Only the in-flow header copy may register the sortable node; slot and
    // selected-item pin copies never do.
    expect(PROJECT_SECTION_SOURCE).toContain(
      'ref={isFlow ? setNodeRef : undefined}',
    );
    expect(COWORK_WORKSPACE_SOURCE).toContain(
      'ref={isFlow ? setNodeRef : undefined}',
    );
  });

  it('keeps sidebar drag affordances on the default cursor', () => {
    for (const source of [
      WORKSPACES_SOURCE,
      PROJECT_SECTION_SOURCE,
      COWORK_WORKSPACE_SOURCE,
      CUSTOMIZE_SIDEBAR_SOURCE,
      PROJECT_HEADER_SOURCE,
      WORKSPACE_HEADER_SOURCE,
    ]) {
      expect(source).not.toContain('cursor-grab');
      expect(source).not.toContain('cursor-grabbing');
    }
    expect(WORKSPACES_SOURCE).toContain('cursor-default touch-none');
    expect(COWORK_WORKSPACE_SOURCE).toContain('cursor-default');
    // Work Entry rows render the shared row, which takes touch-none only
    // while the host hands it a drag binding (CAN-3053).
    expect(COWORK_WORKSPACE_SOURCE).toMatch(/<WorkEntryRow\b/);
    expect(COWORK_WORKSPACE_SOURCE).toContain('drag={drag}');
    expect(WORK_ENTRY_ROW_SOURCE).toContain(
      "dragBinding ? 'touch-none select-none' : ''",
    );
    expect(WORK_ENTRY_ROW_SOURCE).not.toContain('cursor-grab');
    expect(PROJECT_HEADER_SOURCE).toContain('cursor-default');
    expect(PROJECT_SECTION_SOURCE).toContain(
      'translate-x-1 cursor-default rounded-row',
    );
    expect(WORKTREE_ROW_SOURCE).toContain(
      "'cursor-default touch-none select-none'",
    );
  });
});
