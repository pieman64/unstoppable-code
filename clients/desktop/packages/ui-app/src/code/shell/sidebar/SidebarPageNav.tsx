'use client';

import { useId, type JSX, type ReactNode, type Ref } from 'react';
import { SidebarNavRow } from '@canopy/ui-shared/components';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import { SidebarScrollArea } from './SidebarScrollArea';

/**
 * The page navigation's surface.
 *
 * - `app-material`: the app sidebar's material, resize surface, instant
 *   hover feedback, and coordinated page handoff transition. The host
 *   stylesheet that defines the app sidebar owns these scopes.
 * - `sidebar`: the plain sidebar surface color, for hosts whose frame owns
 *   the rail's material and width.
 */
export type SidebarPageNavSurface = 'app-material' | 'sidebar';

export interface SidebarPageNavProps {
  readonly ariaLabel: string;
  readonly sidebarTestId: string;
  readonly backTestId: string;
  readonly scrollViewportTestId: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
  readonly surface: SidebarPageNavSurface;
  readonly backLabel?: string;
  readonly backButtonRef?: Ref<HTMLButtonElement>;
  /**
   * A fixed pixel width. Omit it when the host frame owns the width (the web
   * rail column and mobile drawer); the surface then fills that frame.
   */
  readonly width?: number;
  /** Rendered above Back, such as a window drag strip. */
  readonly topInset?: ReactNode;
  /** Rendered after the content layer, such as a resize handle. */
  readonly trailing?: ReactNode;
  /** Host interaction treatment, such as opting out of window drag regions. */
  readonly controlsInDragRegion?: boolean;
}

const SURFACE_CLASSNAME: Readonly<Record<SidebarPageNavSurface, string>> = {
  'app-material':
    'app-sidebar-material sidebar-resizable-surface sidebar-instant-interactions relative h-full shrink-0 select-none font-normal',
  sidebar: 'bg-sidebar relative h-full shrink-0 select-none font-normal',
};

const CONTENT_CLASSNAME: Readonly<Record<SidebarPageNavSurface, string>> = {
  'app-material': 'settings-sidebar-content absolute inset-0 flex flex-col',
  sidebar: 'absolute inset-0 flex flex-col',
};

/**
 * Full-height secondary-page navigation: a fixed Back control above a
 * scrolling list of labeled groups. Desktop Settings and the web settings rail
 * share it. The host declares its drag region, while the shared mask lets
 * rows fade beneath Back on both platforms.
 */
export function SidebarPageNav({
  ariaLabel,
  sidebarTestId,
  backTestId,
  scrollViewportTestId,
  onBack,
  children,
  surface,
  backLabel = 'Back',
  backButtonRef,
  width,
  topInset,
  trailing,
  controlsInDragRegion = false,
}: SidebarPageNavProps): JSX.Element {
  return (
    <aside
      aria-label={ariaLabel}
      className={
        width === undefined
          ? `${SURFACE_CLASSNAME[surface]} w-full`
          : SURFACE_CLASSNAME[surface]
      }
      style={width === undefined ? undefined : { width }}
      data-testid={sidebarTestId}
    >
      <div className={CONTENT_CLASSNAME[surface]}>
        {topInset}
        <div
          className={
            controlsInDragRegion
              ? 'electron-no-drag shrink-0 px-2 pt-2'
              : 'shrink-0 px-2 pt-2'
          }
        >
          <SidebarNavRow
            ref={backButtonRef}
            onClick={onBack}
            data-testid={backTestId}
            // Web gives every button a hand cursor; Back keeps the arrow like
            // the rail rows below it.
            className="cursor-default text-left"
            tone="secondary"
            icon={<BackIcon size={16} />}
          >
            {backLabel}
          </SidebarNavRow>
        </div>
        <SidebarScrollArea
          className="min-h-0 flex-1"
          contentClassName="px-2"
          viewportClassName={
            controlsInDragRegion
              ? 'settings-nav-scroll-mask electron-no-drag pb-2'
              : 'settings-nav-scroll-mask pb-2'
          }
          viewportTestId={scrollViewportTestId}
        >
          {children}
        </SidebarScrollArea>
      </div>
      {trailing}
    </aside>
  );
}

export interface SidebarPageNavGroupProps {
  /**
   * Visible, accessible group heading. `null` for rows that a control above
   * them already names (the settings scope picker); `ariaLabel` then names
   * the group for assistive technology.
   */
  readonly label: ReactNode | null;
  /** The group's accessible name when it has no visible heading. */
  readonly ariaLabel?: string;
  /** Stable automation hook; never used as the heading's DOM ID. */
  readonly testId: string;
  readonly children: ReactNode;
}

/**
 * One labeled group of page-nav rows. The heading ID is instance-unique so a
 * host may mount the same navigation twice (a rail and a drawer) at once.
 */
export function SidebarPageNavGroup({
  label,
  ariaLabel,
  testId,
  children,
}: SidebarPageNavGroupProps): JSX.Element {
  const headingId = useId();
  if (label === null) {
    return (
      <section aria-label={ariaLabel} className="mt-1" data-testid={testId}>
        <div className="flex flex-col gap-px">{children}</div>
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="mt-3" data-testid={testId}>
      <div id={headingId} className="px-2 text-xs font-normal fg-tertiary">
        {label}
      </div>
      <div className="mt-1 flex flex-col gap-px">{children}</div>
    </section>
  );
}
