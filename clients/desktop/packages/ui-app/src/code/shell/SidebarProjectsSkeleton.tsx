import type { JSX } from 'react';
import { Skeleton, WorkspaceSectionHeader } from '@canopy/ui-shared/components';

/** Collapsed projects with plain short names, as a first load lists them. */
const SAMPLE_PROJECTS: readonly string[] = ['canopy', 'website', 'docs'];

const noop = (): void => undefined;

/**
 * The Projects list before its first snapshot: the sidebar's own project
 * headers, rendered from sample projects inside the measured `Skeleton`, so
 * the bars sit where the rows will. "Loading projects" is announced to
 * assistive technology only.
 */
export function SidebarProjectsSkeleton({
  testId,
}: {
  readonly testId?: string;
}): JSX.Element {
  return (
    <Skeleton loading label="Loading projects" testId={testId}>
      <div className="flex flex-col gap-1">
        {SAMPLE_PROJECTS.map((name) => (
          <WorkspaceSectionHeader
            key={name}
            name={name}
            workspaceType="single-repo"
            worktreeCount={0}
            countPresentation="hidden"
            textScale="sidebar"
            collapsed
            disableDrag
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={noop}
          />
        ))}
      </div>
    </Skeleton>
  );
}
