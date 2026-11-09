import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_INITIATED_WORK_WATCHER_GRANTS,
  type CanopyCallerDescriptor,
  type WatcherCreateRequest,
} from '@canopy/protocol/canopy-core';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import type { CoreWatcherHost } from '../core-watcher-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'desktop-agent-watchers',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants,
});
const READ = caller([CORE_INITIATED_WORK_WATCHER_GRANTS.read]);
const WRITE = caller([CORE_INITIATED_WORK_WATCHER_GRANTS.write]);
const RECIPIENT = {
  workspaceId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  delegation: { delegationId: 'd', description: 'Review', depth: 1 },
};
const DESTINATION: AppAdvisorWatcherDestination = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  delegationId: 'd',
  delegationDescription: 'Review',
  delegationDepth: 1,
};
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

interface Calls {
  lists: unknown[];
  creates: {
    request: WatcherCreateRequest;
    destination: AppAdvisorWatcherDestination;
    createdBy?: string;
  }[];
  deletes: { ids: string[]; destination: AppAdvisorWatcherDestination }[];
}

function fakeHost(): { host: CoreWatcherHost; calls: Calls } {
  const calls: Calls = { lists: [], creates: [], deletes: [] };
  let created = 0;
  const host: CoreWatcherHost = {
    list: (search, destination) => {
      calls.lists.push({ search, destination });
      return Promise.resolve({ text: '{"catalog":[]}' });
    },
    create: (request, destination, call) => {
      calls.creates.push({
        request,
        destination,
        ...(call.createdBy ? { createdBy: call.createdBy } : {}),
      });
      created += 1;
      return Promise.resolve(
        request.kind === 'github'
          ? {
              text: '{"ok":false}',
              isError: true,
              failure: { code: 'github_auth', message: 'Reconnect' },
            }
          : { text: `{"ok":true,"watcher":"w${created}"}` },
      );
    },
    delete: (ids, destination) => {
      calls.deletes.push({ ids, destination });
      return Promise.resolve({ text: '{"results":[]}' });
    },
  };
  return { host, calls };
}

let root: string;
let runtime: DesktopCanopyDispatcher;
let calls: Calls;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-watcher-'));
  const fake = fakeHost();
  calls = fake.calls;
  runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    watcherHost: fake.host,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('core.initiatedWork.watcher on the desktop dispatcher (CAN-5994)', () => {
  it('lists, creates and deletes for the recipient chat, with its delegation', async () => {
    await expect(
      runtime.query(
        'core.initiatedWork.watcher.list',
        { recipient: RECIPIENT, search: { query: 'pipeline' } },
        { caller: READ },
      ),
    ).resolves.toEqual({ accepted: true, report: '{"catalog":[]}' });
    const wakeup = {
      kind: 'wakeup' as const,
      delaySeconds: 60,
      followUpInstruction: 'Check CI',
    };
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.create',
        {
          recipient: RECIPIENT,
          request: wakeup,
          createdBy: 'toolu_1',
          _meta: meta('k1'),
        },
        { caller: WRITE, metadata: meta('k1') },
      ),
    ).resolves.toEqual({
      accepted: true,
      report: '{"ok":true,"watcher":"w1"}',
    });
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.delete',
        { recipient: RECIPIENT, watcherIds: ['w1'], _meta: meta('k2') },
        { caller: WRITE, metadata: meta('k2') },
      ),
    ).resolves.toEqual({ accepted: true, report: '{"results":[]}' });
    expect(calls.lists).toEqual([
      { search: { query: 'pipeline' }, destination: DESTINATION },
    ]);
    expect(calls.creates).toEqual([
      { request: wakeup, destination: DESTINATION, createdBy: 'toolu_1' },
    ]);
    expect(calls.deletes).toEqual([{ ids: ['w1'], destination: DESTINATION }]);
  });

  it('creates once per idempotency key and refuses the key with other parameters', async () => {
    const params = {
      recipient: RECIPIENT,
      request: { kind: 'setup' as const, input: { watchers: [] } },
      createdBy: 'toolu_2',
      _meta: meta('k3'),
    };
    const first = await runtime.instruction(
      'core.initiatedWork.watcher.create',
      params,
      { caller: WRITE, metadata: meta('k3') },
    );
    const replay = await runtime.instruction(
      'core.initiatedWork.watcher.create',
      params,
      { caller: WRITE, metadata: meta('k3') },
    );
    expect(replay).toEqual(first);
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.create',
        { ...params, createdBy: 'toolu_3' },
        { caller: WRITE, metadata: meta('k3') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    expect(calls.creates).toHaveLength(1);
  });

  it('refuses without the operation’s grant before the watcher service is reached', async () => {
    await expect(
      runtime.query(
        'core.initiatedWork.watcher.list',
        { recipient: RECIPIENT, search: {} },
        { caller: WRITE },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.delete',
        { recipient: RECIPIENT, watcherIds: ['w1'], _meta: meta('k4') },
        { caller: READ, metadata: meta('k4') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls).toEqual({ lists: [], creates: [], deletes: [] });
  });

  it('accepts a SetupWatchers batch over 32 KB that the tool accepts', async () => {
    const watchers = Array.from({ length: 5 }, (_, index) => ({
      target: { pipelineId: `pipeline-${index}` },
      followUpInstruction: 'x'.repeat(8000),
    }));
    expect(JSON.stringify({ watchers }).length).toBeGreaterThan(32_768);
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.create',
        {
          recipient: RECIPIENT,
          request: { kind: 'setup', input: { watchers } },
          _meta: meta('k6'),
        },
        { caller: WRITE, metadata: meta('k6') },
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(calls.creates).toHaveLength(1);
  });

  it('reports a refusal and its integration failure without throwing', async () => {
    await expect(
      runtime.instruction(
        'core.initiatedWork.watcher.create',
        {
          recipient: RECIPIENT,
          request: { kind: 'github', input: { items: ['1'] } },
          _meta: meta('k5'),
        },
        { caller: WRITE, metadata: meta('k5') },
      ),
    ).resolves.toEqual({
      accepted: false,
      report: '{"ok":false}',
      failure: { code: 'github_auth', message: 'Reconnect' },
    });
  });
});
