export function parseInternalRootMigrationOptions(args: readonly string[]): {
  readonly brandId: 'canopy' | 'unstoppable-code';
  readonly apply: boolean;
  readonly declareInternal: boolean;
  readonly rebuild: boolean;
  readonly skipMigration: boolean;
  readonly sourceDirectory?: string;
} {
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
    args.some(
      (arg) => !allowed.includes(arg) && !arg.startsWith('--source-dir='),
    ) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith('--brand=')).length !== 1 ||
    sources.length > 1 ||
    sources.some((arg) => arg === '--source-dir=') ||
    (skipMigration &&
      (sources.length > 0 ||
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
      'Usage: node --import tsx apps/desktop-app/scripts/internal-root-migration.ts --brand=canopy|unstoppable-code [--inventory | --apply | --skip-migration] [--source-dir=<absolute-directory>] [--declare-internal] [--rebuild]',
    );
  return {
    brandId: args.includes('--brand=canopy') ? 'canopy' : 'unstoppable-code',
    apply: args.includes('--apply'),
    declareInternal: args.includes('--declare-internal'),
    rebuild: args.includes('--rebuild'),
    skipMigration,
    ...(sources[0] === undefined
      ? {}
      : { sourceDirectory: sources[0].slice('--source-dir='.length) }),
  };
}
