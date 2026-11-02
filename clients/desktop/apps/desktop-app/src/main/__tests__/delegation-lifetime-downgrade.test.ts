// Phase 13 downgrade proof (README section 9, C35). By default this checks the
// candidate: a worktree retaining 513 legacy delegations loads, starts its
// broker and recovers. With CANOPY_DOWNGRADE_BUILD=parent the same file runs in
// a checkout from before phase 13 against an isolated copy of the same bytes
// (CANOPY_DOWNGRADE_FIXTURE_DIR) and proves the accepted break: the old loader
// and broker refuse, and recovery returns no mutations so the chat still loads.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
} from '@canopy/desktop-shared/node/delegation/__tests__/broker-harness';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type {
  ArchivedChatsFile,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import { loadDelegationRecoveryMutations } from '../agents/delegation/recovery';
import * as mainProcessLogging from '../lib/main-process-logging';

jest.setTimeout(120_000);

let mockRoot = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));

const RETAINED = 513;
const scope = { projectId: 'p', worktreeId: 'w' };
const parentBuild = process.env.CANOPY_DOWNGRADE_BUILD === 'parent';

function record(index: number): StoredDelegation {
  const delegationId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    version: 1,
    parent: rootParent,
    task: baseTask,
    route: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
    callKey: index.toString(16).padStart(64, '0'),
    requestHash: 'b'.repeat(64),
    createdAt: index + 1,
    state: {
      delegationId,
      runGeneration: 1,
      sequence: 1,
      status: 'completed',
      outputTruncated: false,
      finishedAt: index + 2,
      nativeSessionId: `native-${index}`,
      transcript: [],
    },
    launch: {
      version: 1,
      delegationId,
      runGeneration: 1,
      launchKey: index.toString(16).padStart(64, '0'),
      phase: 'settled',
      terminalStatus: 'completed',
      nativeSessionId: `native-${index}`,
    },
    delivery: { status: 'suppressed', reason: 'automatic_delivery_removed' },
  };
}

const tabs: ChatTabsFile = {
  version: 1,
  activeTabId: 'retained-chat',
  tabs: [
    {
      id: 'retained-chat',
      title: 'Retained',
      createdAt: '2026-10-20T00:00:00.000Z',
      messages: [
        {
          id: 'u',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Delegate' }],
        },
      ],
    },
  ],
};
const archives: ArchivedChatsFile = { version: 1, archived: [] };

let runs = '';
let records: StoredDelegation[] = [];

beforeAll(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'delegation-downgrade-'));
  runs = join(
    mockRoot,
    scope.projectId,
    scope.worktreeId,
    'delegation',
    'runs',
  );
  records = Array.from({ length: RETAINED }, (_, index) => record(index));
  const source = process.env.CANOPY_DOWNGRADE_FIXTURE_DIR;
  if (source) {
    // Work on a copy so neither build's startup writes reach the shared bytes.
    await cp(source, runs, { recursive: true });
  } else {
    const storage = new FileDelegationStorage(runs);
    for (const entry of records) await storage.commit(entry);
    const out = process.env.CANOPY_DOWNGRADE_FIXTURE_OUT;
    if (out) await cp(runs, out, { recursive: true });
  }
  expect(
    (await readdir(runs)).filter((name) => name.endsWith('.json')),
  ).toHaveLength(RETAINED);
});

afterAll(async () => {
  await rm(mockRoot, { recursive: true, force: true });
});

it('loads the retained directory only after phase 13', async () => {
  const load = new FileDelegationStorage(runs).load();
  if (parentBuild)
    await expect(load).rejects.toThrow(
      'Delegation storage exceeds its record bound',
    );
  else await expect(load).resolves.toHaveLength(RETAINED);
});

it('starts the broker on 513 retained records only after phase 13', async () => {
  const storage = new MemoryDelegationStorage();
  for (const entry of records)
    storage.records.set(entry.state.delegationId, entry);
  const harness = createBrokerHarness({}, storage);
  try {
    if (parentBuild)
      await expect(harness.broker.initialize()).rejects.toThrow(
        'Delegation registry exceeds its bound',
      );
    else await expect(harness.broker.initialize()).resolves.toBeUndefined();
  } finally {
    await harness.broker.close();
  }
});

it('keeps the chat loadable on either build', async () => {
  const warn = jest
    .spyOn(mainProcessLogging, 'logMainProcessWarn')
    .mockImplementation(() => undefined);
  try {
    // Recovery never throws into chat loading: the old build reports the
    // unreadable registry and returns no mutations, so the tabs load as stored.
    await expect(
      loadDelegationRecoveryMutations(scope, tabs, archives),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(parentBuild ? 1 : 0);
  } finally {
    warn.mockRestore();
  }
});
