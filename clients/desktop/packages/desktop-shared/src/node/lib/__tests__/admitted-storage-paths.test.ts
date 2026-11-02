import { join, resolve } from 'node:path';
import {
  admittedStorageRowForPath,
  isAdmittedStorageCandidate,
} from '../admitted-storage-paths';

const ROOT = resolve('/data/canopy');

it.each([
  ['Preferences.JSON', 'preferences'],
  ['preferences.backup-2026-10-30T00-00-00-000Z-abc.json', 'preferences'],
  ['MIGRATIONS.json', 'startup_migrations'],
  ['workspaces/ws-1/approvals.json', 'workspace_approvals'],
  ['App-Workspaces/app-advisor/Approvals.json', 'workspace_approvals'],
])('names %s, in any case, as %s', (relative, row) => {
  expect(admittedStorageRowForPath(join(ROOT, relative), ROOT)).toBe(row);
});

it.each([
  'nested/preferences.json',
  'pipeline-plugin-preferences.json',
  'preferences.json.tmp',
  'preferences.backup-.json',
  'workspaces/approvals.json',
  'workspaces/ws-1/nested/approvals.json',
  'other/ws-1/approvals.json',
  'workspaces/ws-1/migrations.json',
])('leaves %s alone', (relative) => {
  expect(admittedStorageRowForPath(join(ROOT, relative), ROOT)).toBeUndefined();
});

it('leaves the same names outside the data root alone', () => {
  for (const name of ['preferences.json', 'migrations.json'])
    expect(
      admittedStorageRowForPath(join(resolve('/repo'), name), ROOT),
    ).toBeUndefined();
  expect(
    admittedStorageRowForPath(
      join(resolve('/repo'), 'workspaces', 'w', 'approvals.json'),
      ROOT,
    ),
  ).toBeUndefined();
});

it('matches the row shapes under any folder without a data root', () => {
  for (const [relative, row] of [
    ['elsewhere/preferences.json', 'preferences'],
    ['elsewhere/migrations.json', 'startup_migrations'],
    ['elsewhere/workspaces/w/approvals.json', 'workspace_approvals'],
  ] as const) {
    const path = join(resolve('/repo'), relative);
    expect(isAdmittedStorageCandidate(path)).toBe(true);
    expect(admittedStorageRowForPath(path, null)).toBe(row);
  }
  expect(
    admittedStorageRowForPath(join(resolve('/repo'), 'approvals.json'), null),
  ).toBeUndefined();
  expect(isAdmittedStorageCandidate(join(ROOT, 'index.json'))).toBe(false);
});

it('resolves relative segments before classifying', () => {
  expect(
    admittedStorageRowForPath(
      join(ROOT, 'workspaces', '..', 'preferences.json'),
      ROOT,
    ),
  ).toBe('preferences');
});
