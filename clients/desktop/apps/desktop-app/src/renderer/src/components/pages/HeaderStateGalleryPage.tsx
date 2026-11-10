import type { JSX } from 'react';
import type { WorktreeTopBarPinnedAction } from '@canopy/ui-app';
import { WorktreeTopBar } from '@/components/panels/WorktreeTopBar';
import { isHeaderStatesPageEnabled } from '@/components/sidebar/header-states-page-flag';
import {
  HEADER_GALLERY_STATES,
  HEADER_STATE_GALLERY_PROJECT_ID,
} from './headerStateGalleryData';
import { useSeededHeaderGalleryState } from './headerStateGallerySeed';
import { Stack, Heading, Surface } from '@canopy/ui-shared/components';

/**
 * Personal reference page for the worktree header, reachable from the sidebar
 * More menu when {@link isHeaderStatesPageEnabled} allows it. Same shape as
 * the Worktree States page: a flag-gated in-app page plus a data module, so
 * the states can be swept with hot reload while iterating on the real bar.
 *
 * Rows render the REAL {@link WorktreeTopBar} — the genuine `Open in` split
 * control, Launch button and layout `•••` menu — driven by seeded store
 * state, so what you see is the shipping component, not a mock of it.
 */

/**
 * Widths for the responsive strip, straddling every threshold the header
 * reacts to: 640 (copy shedding), then the priority tiers at 560 (archive),
 * 480 (Create PR), 420 (badges), 360 (`Open in`), 200 (launch cluster).
 */
const TIER_WIDTHS = [900, 660, 620, 520, 460, 400, 340, 220] as const;

/**
 * Pinned-script widths: labels at 760 and above, compact play buttons below,
 * and no pins under 400.
 */
const PIN_WIDTHS = [900, 740, 460, 380] as const;

/** Sample pins; clicking them does nothing on this page. */
const GALLERY_PINS: readonly WorktreeTopBarPinnedAction[] = [
  {
    id: 'gallery-dev',
    label: 'dev',
    command: 'pnpm run dev',
    target: 'canopy/apps/web',
    shortcut: '⌘⇧Y',
    running: true,
    onRun: () => undefined,
  },
  {
    id: 'gallery-lint',
    label: 'lint',
    command: 'pnpm run lint',
    target: 'canopy',
    running: false,
    onRun: () => undefined,
  },
  {
    id: 'gallery-test',
    label: 'test',
    command: 'make test',
    target: 'api',
    running: false,
    pending: true,
    onRun: () => undefined,
  },
];

/** One row: the real top bar at an optional fixed width. */
export function HeaderGalleryRow({
  worktreeId,
  width,
  pinnedActions,
}: {
  worktreeId: string;
  width?: number;
  pinnedActions?: readonly WorktreeTopBarPinnedAction[];
}): JSX.Element {
  return (
    <div
      style={width === undefined ? undefined : { width: `${width}px` }}
      data-testid={`header-state-row-${worktreeId}`}
    >
      <Surface variant="outline" className="overflow-hidden">
        <WorktreeTopBar
          projectId={HEADER_STATE_GALLERY_PROJECT_ID}
          worktreeId={worktreeId}
          viewMode="list"
          viewModeReady
          pinnedActions={pinnedActions}
        />
      </Surface>
    </div>
  );
}

/**
 * Flag gate at the PAGE, not just the menu entry: `header-states` has to stay
 * in the App Advisor navigation allowlist (an unlisted page is dropped
 * silently, so the menu item would appear and do nothing), which means a
 * packaged build could still be navigated here by asking the advisor for the
 * page by name. With the flag off the page renders a placeholder and — since
 * the gallery component never mounts — seeds nothing into the stores.
 *
 * A wrapper rather than an early return inside the gallery, so the gallery's
 * hooks run unconditionally whenever it mounts.
 */
export function HeaderStateGalleryPage(): JSX.Element {
  if (!isHeaderStatesPageEnabled()) {
    return (
      <Surface
        variant="pane"
        extent="parent"
        className="flex items-center justify-center"
        data-testid="header-states-page-disabled"
      >
        <p className="text-xs fg-secondary">
          This page is a development-only reference and is not enabled in this
          build.
        </p>
      </Surface>
    );
  }
  return <HeaderStateGalleryContent />;
}

function HeaderStateGalleryContent(): JSX.Element {
  const ready = useSeededHeaderGalleryState();

  return (
    // Header stays put; ONE constrained scroller owns the overflow. The page
    // sits inside `<main>`, which already scrolls — a `h-full overflow-auto`
    // root nested a second scroller inside it and made the wheel fight
    // between them. Same structure the Worktree States page uses.
    <Surface
      variant="pane"
      extent="parent"
      className="flex flex-col"
      data-testid="header-states-page"
    >
      <header className="flex flex-col gap-1 px-8 pb-4 pt-8 fg-primary">
        <Heading level={1} variant="page">
          Worktree header — all states
        </Heading>
        <p className="max-w-3xl text-xs fg-secondary">
          Personal reference for the worktree header. Every row is the real{' '}
          <code>WorktreeTopBar</code> driven by seeded state — no git, no
          network. The synthetic project is scoped to this page and removed when
          you navigate away.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12 fg-primary">
        {!ready ? (
          <div className="fg-secondary">Seeding…</div>
        ) : (
          <div className="flex flex-col gap-12">
            <section className="flex flex-col gap-3">
              <Heading className="" level={2} variant="title">
                States
              </Heading>
              <Stack gap="section">
                {HEADER_GALLERY_STATES.map((state) => (
                  <div
                    key={state.id}
                    className="flex flex-col gap-1.5"
                    data-testid={`header-state-${state.id}`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium">{state.title}</span>
                      <span className="text-2xs fg-secondary">
                        {state.note}
                      </span>
                    </div>
                    <HeaderGalleryRow worktreeId={state.id} />
                  </div>
                ))}
              </Stack>
            </section>

            <section className="flex flex-col gap-3">
              <Stack gap="tight">
                <Heading className="" level={2} variant="title">
                  Responsive behavior
                </Heading>
                <p className="max-w-3xl text-xs fg-secondary">
                  The same state at shrinking widths. Copy sheds first (
                  <code>Create PR</code> → <code>PR</code>, Launch → icon at
                  640), then controls drop by priority: archive (560), Create PR
                  (480), badges (420), pinned scripts (400),{' '}
                  <code>Open in</code> (360). Labels truncate only once the
                  space is genuinely gone, base branch first.
                </p>
              </Stack>
              {/* These rows are FIXED pixel widths — that is the point — so on
                  a narrow content region they are wider than the page. Give
                  the strip its own horizontal scroller: otherwise the page's
                  vertical scroller inherited the overflow (932px of content
                  in a 629px box) and scrolled on both axes, since setting one
                  axis to `auto` computes the other to `auto` too. The
                  negative margin lets it scroll full-bleed while the rows keep
                  the section's padding. */}
              <div className="-mx-8 overflow-x-auto px-8">
                <div className="flex w-max flex-col gap-4">
                  {TIER_WIDTHS.map((width) => (
                    <Stack
                      gap="tight"
                      key={width}
                      data-testid={`header-state-tier-${width}`}
                    >
                      <div className="text-2xs fg-secondary">{width}px</div>
                      <HeaderGalleryRow
                        worktreeId="long-branch"
                        width={width}
                      />
                    </Stack>
                  ))}
                </div>
              </div>
            </section>

            <section
              className="flex flex-col gap-3"
              data-testid="header-state-pins"
            >
              <Stack gap="tight">
                <Heading className="" level={2} variant="title">
                  Pinned scripts
                </Heading>
                <p className="max-w-3xl text-xs fg-secondary">
                  Running, idle and starting pins before the launch cluster.
                  Labels collapse to play buttons below 760, and pins drop below
                  400, before <code>Open in</code> and Launch.
                </p>
              </Stack>
              <div className="-mx-8 overflow-x-auto px-8">
                <div className="flex w-max flex-col gap-4">
                  {PIN_WIDTHS.map((width) => (
                    <Stack
                      gap="tight"
                      key={width}
                      data-testid={`header-state-pins-${width}`}
                    >
                      <div className="text-2xs fg-secondary">{width}px</div>
                      <HeaderGalleryRow
                        worktreeId="long-branch"
                        width={width}
                        pinnedActions={GALLERY_PINS}
                      />
                    </Stack>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </Surface>
  );
}
