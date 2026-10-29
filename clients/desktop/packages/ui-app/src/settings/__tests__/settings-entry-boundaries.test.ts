// eslint-disable-next-line no-restricted-imports
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { dirname, join, normalize } from 'node:path';

/**
 * Narrow settings entries must not statically load payment editors, Stripe,
 * charts or the memory force graph: the rail and credit summaries render on
 * desktop (which never mounts Stripe) and on the first screen of web settings
 * pages. Heavy modules stay behind `import()`.
 */

const REPO_ROOT = process.cwd();

const PACKAGE_ROOTS: Readonly<Record<string, string>> = {
  '@canopy/ui-app': 'packages/ui-app/src',
  '@canopy/ui-shared': 'packages/ui-shared/src',
  '@canopy/app-state': 'packages/app-state/src',
  '@canopy/app-core': 'packages/app-core/src',
  '@canopy/protocol': 'packages/protocol/src',
};

const FORBIDDEN_SPECIFIERS = [
  /^@stripe\//,
  /^recharts$/,
  /^react-force-graph-2d$/,
  /billing\/stripe-browser$/,
];

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function resolveFile(base: string): string | null {
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(REPO_ROOT, candidate)))
      return candidate;
  }
  return null;
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.'))
    return resolveFile(normalize(join(dirname(fromFile), specifier)));
  for (const [name, root] of Object.entries(PACKAGE_ROOTS)) {
    if (specifier === name) return resolveFile(join(root, 'index'));
    if (specifier.startsWith(`${name}/`))
      return resolveFile(join(root, specifier.slice(name.length + 1)));
  }
  return null;
}

/** Forbidden static imports reachable from an entry, with the importing file. */
function forbiddenReachable(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    const pattern = new RegExp(STATIC_IMPORT.source, 'g');
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match !== null) {
      const specifier: string | undefined = match[1];
      match = pattern.exec(source);
      if (specifier === undefined) continue;
      if (FORBIDDEN_SPECIFIERS.some((forbidden) => forbidden.test(specifier))) {
        offenders.push(`${file} -> ${specifier}`);
        continue;
      }
      const resolved = resolveSpecifier(specifier, file);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return offenders;
}

describe('settings entry boundaries', () => {
  it.each([
    'packages/ui-app/src/settings/navigation/index.ts',
    'packages/ui-app/src/settings/billing/index.ts',
    'packages/ui-app/src/settings/pages/index.ts',
    'packages/ui-app/src/settings/host/index.ts',
    'packages/ui-app/src/settings/memory/index.ts',
    'packages/ui-app/src/settings/organization/OrganizationStatisticsPage.tsx',
    'packages/ui-app/src/settings/memory/OrganizationMemoryGraphPage.tsx',
    'packages/ui-app/src/settings/billing/AccountBillingPage.tsx',
    'packages/ui-app/src/settings/billing/OrganizationInvoicePage.tsx',
  ])('%s loads no Stripe, chart or force-graph module statically', (entry) => {
    expect(forbiddenReachable(entry)).toEqual([]);
  });

  it('detects a forbidden static import', () => {
    expect(
      forbiddenReachable(
        'packages/ui-app/src/settings/organization/statistics/charts.tsx',
      ),
    ).not.toEqual([]);
  });
});
