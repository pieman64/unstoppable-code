/** Snapshot selection is independent of preference changes and repo policy. */
export async function selectSessionInstructions(options: {
  provider: string;
  isInteractiveCode: boolean;
  resumed: boolean;
  saved?: string;
  active?: string;
  /** Provider of the live session that holds `active`. */
  activeProvider?: string;
  currentGlobal: string;
  compose: () => Promise<string>;
}): Promise<string> {
  if (options.resumed) return options.saved ?? options.active ?? '';
  if (options.provider === 'cursor') return options.currentGlobal;
  // A live session of the same provider keeps its snapshot. One from another
  // provider is being replaced, so the new session starts from fresh
  // instructions instead of inheriting the old harness's block.
  if (
    options.active !== undefined &&
    options.activeProvider === options.provider
  )
    return options.active;
  if (!options.isInteractiveCode) return options.currentGlobal;
  const rules = await options.compose().catch(() => '');
  return [options.currentGlobal, rules].filter(Boolean).join('\n\n');
}
