/** The persisted identity and parent link needed to verify pipeline lineage. */
export interface PipelineExecutionLineage {
  readonly id: string;
  readonly parent_execution_id?: string;
}

/**
 * Resolve a child execution to its root only when every parent link is present
 * and consistent. `parentChain` is ordered from the immediate parent to the
 * oldest ancestor. A root execution resolves to its own id; callers that only
 * record a root id for nested work should omit that result for root executions.
 */
export function resolveRootPipelineExecutionId(
  state: PipelineExecutionLineage,
  parentChain: readonly PipelineExecutionLineage[],
): string | undefined {
  if (state.id.length === 0) return undefined;
  if (state.parent_execution_id === undefined) {
    return parentChain.length === 0 ? state.id : undefined;
  }

  const visited = new Set([state.id]);
  let expectedParentId = state.parent_execution_id;

  for (let index = 0; index < parentChain.length; index += 1) {
    if (expectedParentId.length === 0) return undefined;

    const ancestor = parentChain[index];
    if (
      !ancestor ||
      ancestor.id.length === 0 ||
      ancestor.id !== expectedParentId ||
      visited.has(ancestor.id)
    ) {
      return undefined;
    }
    visited.add(ancestor.id);

    if (ancestor.parent_execution_id === undefined) {
      return index === parentChain.length - 1 ? ancestor.id : undefined;
    }
    expectedParentId = ancestor.parent_execution_id;
  }

  return undefined;
}

/** Return a verified root id only when the current execution is nested. */
export function getNestedRootPipelineExecutionId(
  state: PipelineExecutionLineage,
  parentChain: readonly PipelineExecutionLineage[],
): string | undefined {
  return state.parent_execution_id === undefined
    ? undefined
    : resolveRootPipelineExecutionId(state, parentChain);
}

/** Load and verify a nested execution's entire ancestor chain before resolving. */
export async function loadNestedRootPipelineExecutionId(
  state: PipelineExecutionLineage,
  loadParent: (
    executionId: string,
  ) => Promise<PipelineExecutionLineage | undefined>,
): Promise<string | undefined> {
  if (state.parent_execution_id === undefined) return undefined;

  const parentChain: PipelineExecutionLineage[] = [];
  const visited = new Set([state.id]);
  let parentExecutionId: string | undefined = state.parent_execution_id;

  try {
    while (parentExecutionId !== undefined) {
      if (parentExecutionId.length === 0 || visited.has(parentExecutionId)) {
        return undefined;
      }
      visited.add(parentExecutionId);
      const parentState = await loadParent(parentExecutionId);
      if (!parentState || parentState.id !== parentExecutionId) {
        return undefined;
      }
      parentChain.push(parentState);
      parentExecutionId = parentState.parent_execution_id;
    }
  } catch {
    return undefined;
  }

  return getNestedRootPipelineExecutionId(state, parentChain);
}
