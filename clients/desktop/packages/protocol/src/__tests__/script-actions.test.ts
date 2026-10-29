import {
  isScriptActionsContext,
  isScriptActionsReviewRequest,
  isScriptActionsSnapshot,
  isScriptActionRelativePath,
  type ScriptAction,
} from '../script-actions';

const action: ScriptAction = {
  id: '["repo","test"]',
  kind: 'detected',
  name: 'test',
  command: 'pnpm test',
  multiline: false,
  repoId: 'repo',
  repoName: 'Repo',
  packagePath: 'apps/web',
  target: { kind: 'repository', repoId: 'repo' },
  source: {
    kind: 'package-json',
    file: 'apps/web/package.json',
    entry: 'test',
    line: null,
  },
  revision: 'digest',
  status: 'pending',
  shortcut: null,
  pinned: false,
};
const snapshot = {
  actions: [action],
  pendingCount: 1,
  shellAliasScanEnabled: false,
  scanStatus: 'complete',
  scannedAt: '2026-10-21T00:00:00Z',
  diagnostics: [],
};
it('validates portable snapshots and refuses host paths and invalid targets', () => {
  expect(isScriptActionsSnapshot(snapshot)).toBe(true);
  for (const patch of [
    { packagePath: '/tmp' },
    { target: { kind: 'repository', repoId: 'other' } },
    { source: { ...action.source, file: '/private/source' } },
    { multiline: true },
    { status: 'trusted' },
  ])
    expect(
      isScriptActionsSnapshot({
        ...snapshot,
        actions: [{ ...action, ...patch }],
      }),
    ).toBe(false);
});
it('bounds review batches, duplicate IDs and scope identifiers', () => {
  const request = {
    projectId: 'project',
    worktreeId: 'tree',
    entries: [{ id: 'test', revision: 'digest' }],
    decision: 'approve',
  };
  expect(isScriptActionsReviewRequest(request)).toBe(true);
  expect(isScriptActionsReviewRequest({ ...request, entries: [] })).toBe(false);
  expect(
    isScriptActionsReviewRequest({
      ...request,
      entries: [request.entries[0], request.entries[0]],
    }),
  ).toBe(false);
  expect(
    isScriptActionsReviewRequest({
      ...request,
      entries: Array(2001).fill(request.entries[0]),
    }),
  ).toBe(false);
  expect(
    isScriptActionsContext({ ...request, projectId: '../workspace' }),
  ).toBe(false);
});
it.each([
  '/tmp',
  '../out',
  'a/../b',
  'C:out',
  '\\\\host\\share',
  'a\\b',
  'a\0b',
])('rejects nonportable directory %s', (value) => {
  expect(isScriptActionRelativePath(value)).toBe(false);
});

it('validates executing-host shortcut metadata at the response boundary', () => {
  expect(
    isScriptActionsSnapshot({
      ...snapshot,
      shortcutContext: {
        platform: 'win32',
        reserved: [{ accelerator: 'Control+Y', title: 'Focus app' }],
      },
    }),
  ).toBe(true);
  for (const shortcutContext of [
    { platform: 'unknown', reserved: [] },
    {
      platform: 'win32',
      reserved: [{ accelerator: null, title: 'Focus app' }],
    },
  ])
    expect(isScriptActionsSnapshot({ ...snapshot, shortcutContext })).toBe(
      false,
    );
});
