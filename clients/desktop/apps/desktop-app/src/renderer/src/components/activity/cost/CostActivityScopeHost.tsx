import { lazy, Suspense, useState, type JSX, type ReactNode } from 'react';
import {
  CostActivityScopeContext,
  type CostActivityScopeValue,
} from './CostActivityScopeContext';

const LazyCostActivityScopeSource = lazy(() =>
  import('./CostActivityScopeSource').then((module) => ({
    default: module.CostActivityScopeSource,
  })),
);

export interface CostActivityScopeHostProps {
  /** The entry whose cost the rail shows; null for a surface that keeps none. */
  readonly projectId: string | null;
  readonly worktreeId: string | null;
  readonly children: ReactNode;
}

/**
 * Provides the rail's cost scope without making the rail wait for the lazily
 * loaded cost code. The children stay mounted as one instance from the first
 * render: the source loads beside them and its value reaches them through
 * context. Wrapping them in the lazy boundary instead would mount them twice,
 * once as its fallback and again once the code arrived, dropping their state.
 */
export function CostActivityScopeHost({
  projectId,
  worktreeId,
  children,
}: CostActivityScopeHostProps): JSX.Element {
  const [reported, setReported] = useState<CostActivityScopeValue | null>(null);
  // A value reported for the previous entry never reaches the next one.
  const value =
    reported !== null &&
    reported.scope.kind === 'entry' &&
    reported.scope.projectId === projectId &&
    reported.scope.worktreeId === worktreeId
      ? reported
      : null;

  return (
    <CostActivityScopeContext.Provider value={value}>
      {projectId !== null && worktreeId !== null ? (
        <Suspense fallback={null}>
          <LazyCostActivityScopeSource
            projectId={projectId}
            worktreeId={worktreeId}
            onChange={setReported}
          />
        </Suspense>
      ) : null}
      {children}
    </CostActivityScopeContext.Provider>
  );
}
