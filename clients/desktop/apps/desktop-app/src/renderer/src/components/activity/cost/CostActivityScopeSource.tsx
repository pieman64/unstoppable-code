import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import { costScopeHasContent, useCostScopeStore } from '@canopy/ui-app/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import type { CostActivityScopeValue } from './CostActivityScopeContext';

export interface CostActivityScopeSourceProps {
  readonly projectId: string;
  readonly worktreeId: string;
  /** Receives the scope's current value, and null when this source unmounts. */
  readonly onChange: (value: CostActivityScopeValue | null) => void;
}

/**
 * Owns one entry-scope cost store shared by the rail, row and preview, and
 * reports it to `CostActivityScopeHost`. It renders nothing, so the host can
 * load it lazily beside the rail instead of around it.
 */
export function CostActivityScopeSource({
  projectId,
  worktreeId,
  onChange,
}: CostActivityScopeSourceProps): null {
  const scope = useMemo<CostScopeRef>(
    () => ({ kind: 'entry', projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const store = useCostScopeStore(desktopCostClient, scope);
  const { value, problem } = store(
    useShallow((state) => ({ value: state.value, problem: state.problem })),
  );
  const hasContent =
    value !== null && problem === null && costScopeHasContent(value);
  const contextValue = useMemo(
    () => ({ scope, store, value, hasContent }),
    [scope, store, value, hasContent],
  );

  useEffect(() => {
    onChange(contextValue);
  }, [contextValue, onChange]);
  useEffect(() => (): void => onChange(null), [onChange]);

  return null;
}
