import type { JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  Skeleton,
  WorkspaceSectionHeader,
} from '@canopy/ui-shared/components';

/** Plain project names the loading skeleton lays out as project rows. */
const SAMPLE_PROJECT_NAMES = ['Storefront', 'Platform', 'Design system'];

const noop = (): void => undefined;

/**
 * The project list while the rail's first snapshot loads: the shared
 * `WorkspaceSectionHeader` rows the sidebar renders, from sample projects,
 * measured inside `Skeleton` so the bars sit where the rows will. "Loading
 * projects" is announced to assistive technology only.
 */
export function SidebarProjectsSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading projects…">
      <Skeleton
        loading
        label="Loading projects"
        testId="sidebar-section-code-loading"
      >
        {SAMPLE_PROJECT_NAMES.map((name) => (
          <div key={name} className="w-full">
            <WorkspaceSectionHeader
              name={name}
              workspaceType="single-repo"
              worktreeCount={0}
              countPresentation="hidden"
              textScale="sidebar"
              collapsed
              canToggleCollapse={false}
              disableDrag
              showCollapseChevron={false}
              onToggleCollapse={noop}
            />
          </div>
        ))}
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}
