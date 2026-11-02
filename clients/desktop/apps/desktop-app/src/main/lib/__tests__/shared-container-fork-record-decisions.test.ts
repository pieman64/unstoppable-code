// W6e2: host admission, X3/X4 routing and the pure manifest apply.
jest.mock('../workspace-record-decision-port', () => ({
  applyWorkspaceManifestDecision: jest.fn(() => Promise.resolve()),
  applyWorkspaceIndexRemoval: jest.fn(() => Promise.resolve(true)),
}));
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  hideSharedContainerForkWorkspace,
  recordSharedContainerForkStartPage,
  SharedContainerForkMetadataRefusedError,
} from '../../shared-containers/fork/fork-metadata';
import { deleteForkWorkspaceOrHide } from '../../shared-containers/fork/rollback';
import { WorkspaceConfigUnreadableError } from '../workspace-persistence';
import { WorkspaceIndexUnreadableError } from '../workspace-index-repository';
import {
  applyWorkspaceManifestDecision,
  applyWorkspaceIndexRemoval,
} from '../workspace-record-decision-port';
import { applySharedContainerForkStartPageTo } from '../worktree-record-decision-apply';
import type {
  SharedContainerForkStartPageDecision,
  W5RecordDecisionPort,
} from '../worktree-record-decisions';

const START_PAGE = {
  kind: 'file' as const,
  repoId: 'repo-a',
  path: 'README.md',
};
const RECORD = {
  source: 'code_fork' as const,
  workspaceId: 'destination',
  startPage: START_PAGE,
};
const fake: Pick<
  W5RecordDecisionPort,
  'applyWorkspaceManifestDecision' | 'applyWorkspaceIndexRemoval'
> = { applyWorkspaceManifestDecision, applyWorkspaceIndexRemoval };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(applyWorkspaceManifestDecision).mockResolvedValue(undefined);
  jest.mocked(applyWorkspaceIndexRemoval).mockResolvedValue(true);
});
it('routes start-page publication and rollback fallback hide as plain decisions through X3/X4', async () => {
  await expect(recordSharedContainerForkStartPage(RECORD)).resolves.toEqual({
    workspaceId: 'destination',
    startPage: START_PAGE,
  });
  const deletion = new Error('delete failed');
  await expect(
    deleteForkWorkspaceOrHide(
      { source: 'code_fork', workspaceId: 'destination' },
      () => Promise.reject(deletion),
    ),
  ).rejects.toBe(deletion);
  expect(
    JSON.parse(
      JSON.stringify(
        jest.mocked(fake.applyWorkspaceManifestDecision).mock.calls,
      ),
    ),
  ).toEqual([
    [
      'destination',
      { kind: 'sharedContainer.fork.start-page', startPage: START_PAGE },
    ],
  ]);
  expect(
    JSON.parse(
      JSON.stringify(jest.mocked(fake.applyWorkspaceIndexRemoval).mock.calls),
    ),
  ).toEqual([['destination', { kind: 'sharedContainer.fork.hide' }]]);
  const manifestOrder = jest.mocked(applyWorkspaceManifestDecision).mock
    .invocationCallOrder[0];
  const hideOrder = jest.mocked(applyWorkspaceIndexRemoval).mock
    .invocationCallOrder[0];
  if (manifestOrder === undefined || hideOrder === undefined) {
    throw new Error('Expected both fork metadata decisions');
  }
  expect(manifestOrder).toBeLessThan(hideOrder);
});
it('does not hide a fork workspace when rollback deletion succeeds', async () => {
  await expect(
    deleteForkWorkspaceOrHide(
      { source: 'code_fork', workspaceId: 'destination' },
      () => Promise.resolve(),
    ),
  ).resolves.toBeUndefined();
  expect(applyWorkspaceIndexRemoval).not.toHaveBeenCalled();
});
it.each(['code_fork', 'cowork_fork'] as const)(
  'reports a missing hide target for %s',
  async (source) => {
    jest.mocked(applyWorkspaceIndexRemoval).mockResolvedValueOnce(false);
    await expect(
      hideSharedContainerForkWorkspace({ source, workspaceId: 'destination' }),
    ).resolves.toEqual({ status: 'not-found' });
  },
);
it.each([
  { ...RECORD, workspaceId: '' },
  { ...RECORD, workspaceId: '../escape' },
  { ...RECORD, source: 'cowork_fork' },
  { ...RECORD, startPage: {} },
  { ...RECORD, startPage: null },
])(
  'refuses invalid start-page admission before the port: %j',
  async (record) => {
    await expect(
      recordSharedContainerForkStartPage(record as typeof RECORD),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(applyWorkspaceManifestDecision).not.toHaveBeenCalled();
  },
);
it.each([
  { source: 'code_fork', workspaceId: '' },
  { source: 'code_fork', workspaceId: '../escape' },
  { source: 'unknown', workspaceId: 'destination' },
])('refuses invalid hide admission before the port: %j', async (request) => {
  await expect(
    hideSharedContainerForkWorkspace(
      request as Parameters<typeof hideSharedContainerForkWorkspace>[0],
    ),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
  expect(applyWorkspaceIndexRemoval).not.toHaveBeenCalled();
});
it('keeps the existing unreadable-manifest translation', async () => {
  jest
    .mocked(applyWorkspaceManifestDecision)
    .mockRejectedValueOnce(new WorkspaceConfigUnreadableError());
  await expect(
    recordSharedContainerForkStartPage(RECORD),
  ).rejects.toMatchObject({
    name: 'SharedContainerForkMetadataRefusedError',
    reason: 'configuration-unavailable',
  });
});
it('keeps both deletion and unreadable-index failures on fallback hide', async () => {
  const deletion = new Error('delete failed');
  jest
    .mocked(applyWorkspaceIndexRemoval)
    .mockRejectedValueOnce(new WorkspaceIndexUnreadableError());
  await expect(
    deleteForkWorkspaceOrHide(
      { source: 'cowork_fork', workspaceId: 'destination' },
      () => Promise.reject(deletion),
    ),
  ).rejects.toMatchObject({
    errors: [
      deletion,
      expect.objectContaining({ reason: 'index-unavailable' }),
    ],
  });
});
it('propagates unexpected writer failures without translating them', async () => {
  const error = new Error('disk full');
  jest.mocked(applyWorkspaceManifestDecision).mockRejectedValueOnce(error);
  await expect(recordSharedContainerForkStartPage(RECORD)).rejects.toBe(error);
  jest.mocked(applyWorkspaceIndexRemoval).mockRejectedValueOnce(error);
  await expect(
    hideSharedContainerForkWorkspace({
      source: 'code_fork',
      workspaceId: 'destination',
    }),
  ).rejects.toBe(error);
});
it.each([{ kind: 'url' as const, url: 'https://example.test' }, START_PAGE])(
  'pure apply changes only startPage: %j',
  (startPage) => {
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'a', name: 'A', repoPath: '/repos/a' }],
    };
    const before = structuredClone(config);
    const decision = JSON.parse(
      JSON.stringify({ kind: 'sharedContainer.fork.start-page', startPage }),
    ) as SharedContainerForkStartPageDecision;
    applySharedContainerForkStartPageTo('destination', config, 'ok', decision);
    expect(config).toEqual({ ...before, startPage });
    applySharedContainerForkStartPageTo('destination', config, 'ok', decision);
    expect(config).toEqual({ ...before, startPage });
  },
);
it('pure apply refuses an absent manifest without changing the defaults', () => {
  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [],
  };
  const before = structuredClone(config);
  expect(() =>
    applySharedContainerForkStartPageTo('destination', config, 'absent', {
      kind: 'sharedContainer.fork.start-page',
      startPage: START_PAGE,
    }),
  ).toThrow(SharedContainerForkMetadataRefusedError);
  expect(config).toEqual(before);
});
