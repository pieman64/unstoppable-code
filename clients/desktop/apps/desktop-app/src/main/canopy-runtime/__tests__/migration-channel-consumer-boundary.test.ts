import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../../../../..');
function consumers(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === 'node_modules' ||
      entry.name === '__tests__' ||
      entry.name === 'tests' ||
      entry.name === 'generated' ||
      entry.name.startsWith('.')
    )
      return [];
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return consumers(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
    const source = readFileSync(file, 'utf8');
    return /(?:from\s*|import\s*\()['"][^'"]*(?:migration-channel|node\/vault)['"]/.test(
      source,
    )
      ? [relative(ROOT, file)]
      : [];
  });
}

it('keeps the migration client and native byte binding out of CLI, agent, renderer, preload and remote control', () => {
  expect(
    [
      ...consumers(join(ROOT, 'apps')),
      ...consumers(join(ROOT, 'packages')),
    ].sort(),
  ).toEqual([
    'apps/desktop-app/src/main/canopy-runtime/electron-daemon-host.ts',
    'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts',
  ]);
  const client = readFileSync(
    join(ROOT, 'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts'),
    'utf8',
  );
  expect(client).not.toMatch(/SCM_RIGHTS|sendHandle|\bfd\s*:/);
  const host = readFileSync(
    join(
      ROOT,
      'apps/desktop-app/src/main/canopy-runtime/electron-daemon-host.ts',
    ),
    'utf8',
  );
  expect(host).not.toMatch(
    /spawnWithChannel|migration:\s*createElectronMigrationLaunch/,
  );
});
