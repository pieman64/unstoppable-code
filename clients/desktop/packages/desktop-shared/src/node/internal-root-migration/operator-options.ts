export function selectInternalRootArchiveAbandonments(
  requested: readonly string[],
  frozen?: readonly string[],
): readonly string[] {
  if (frozen === undefined) return requested;
  const names = [...new Set(frozen)];
  if (
    requested.length &&
    (requested.length !== names.length ||
      requested.some((name) => !names.includes(name)))
  )
    throw new Error(
      `Archive abandonment is already frozen by the existing apply. Preserve both roots; inventory and resume must use all original opt-ins (${names.join(', ') || 'none'}) or no archive flags.`,
    );
  return names;
}

export function parseInternalRootMigrationOptions(args: readonly string[]): {
  readonly brandId: 'canopy' | 'unstoppable-code';
  readonly apply: boolean;
  readonly declareInternal: boolean;
  readonly rebuild: boolean;
  readonly skipMigration: boolean;
  readonly sourceDirectory?: string;
  readonly abandonArchives: readonly string[];
} {
  const abandonArchives: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--abandon-archive') {
      abandonArchives.push(args[++i] ?? '');
    } else if (arg?.startsWith('--abandon-archive=')) {
      abandonArchives.push(arg.slice('--abandon-archive='.length));
    } else if (arg !== undefined) remaining.push(arg);
  }
  args = remaining;
  const allowed = [
    '--brand=canopy',
    '--brand=unstoppable-code',
    '--apply',
    '--declare-internal',
    '--inventory',
    '--rebuild',
    '--skip-migration',
  ];
  const sources = args.filter((arg) => arg.startsWith('--source-dir='));
  const skipMigration = args.includes('--skip-migration');
  if (
    abandonArchives.some(
      (name) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(name),
    ) ||
    new Set(abandonArchives).size !== abandonArchives.length ||
    args.some(
      (arg) => !allowed.includes(arg) && !arg.startsWith('--source-dir='),
    ) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith('--brand=')).length !== 1 ||
    sources.length > 1 ||
    sources.some((arg) => arg === '--source-dir=') ||
    (skipMigration &&
      (abandonArchives.length > 0 ||
        sources.length > 0 ||
        args.some((arg) =>
          [
            '--apply',
            '--inventory',
            '--rebuild',
            '--declare-internal',
          ].includes(arg),
        ))) ||
    (args.includes('--apply') && args.includes('--inventory')) ||
    (args.includes('--rebuild') && !args.includes('--apply'))
  )
    throw new Error(
      'Usage: node --import tsx apps/desktop-app/scripts/internal-root-migration.ts --brand=canopy|unstoppable-code [--inventory | --apply | --skip-migration] [--source-dir=<absolute-directory>] [--declare-internal] [--rebuild] [--abandon-archive <workspace/worktree>]...',
    );
  return {
    brandId: args.includes('--brand=canopy') ? 'canopy' : 'unstoppable-code',
    apply: args.includes('--apply'),
    declareInternal: args.includes('--declare-internal'),
    rebuild: args.includes('--rebuild'),
    skipMigration,
    abandonArchives,
    ...(sources[0] === undefined
      ? {}
      : { sourceDirectory: sources[0].slice('--source-dir='.length) }),
  };
}
