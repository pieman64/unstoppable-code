const generations = new Map<string, number>();

export function panelHydrationGeneration(worktreeKey: string): number {
  return generations.get(worktreeKey) ?? 0;
}

export function isPanelHydrationGenerationCurrent(
  worktreeKey: string,
  generation: number,
): boolean {
  return panelHydrationGeneration(worktreeKey) === generation;
}

export function advancePanelHydrationGeneration(worktreeKey: string): void {
  generations.set(worktreeKey, panelHydrationGeneration(worktreeKey) + 1);
}
