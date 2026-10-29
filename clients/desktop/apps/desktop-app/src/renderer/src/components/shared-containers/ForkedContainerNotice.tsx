import type { JSX } from 'react';
import { ForkedFromNotice } from './ForkedFromNotice';
import { useSharedContainerForkProvenance } from './useSharedContainerForkProvenance';

/** Persistent provenance shown on an independent local fork after navigation. */
export function ForkedContainerNotice({
  projectId,
  worktreeId,
}: {
  projectId: string | null;
  worktreeId: string | null;
}): JSX.Element | null {
  const provenance = useSharedContainerForkProvenance(projectId, worktreeId);
  if (provenance === null) return null;

  return (
    <div className="shrink-0 border-b bg-subtle px-3 py-1.5">
      <ForkedFromNotice provenance={provenance} />
    </div>
  );
}
