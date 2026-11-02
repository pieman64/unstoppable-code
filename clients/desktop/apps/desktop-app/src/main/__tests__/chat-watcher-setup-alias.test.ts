/**
 * Runs the live watcher setup service against the real chat watcher access
 * resolver; only project-discovery reads and host services are mocked.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlineChatWatcherReservationInput } from '@canopy/desktop-shared/lib/chat-send-actions';
import type { CanonicalChatWatcherSetupInput } from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import type {
  ChatStateSnapshot,
  ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import { readCanonicalWatcherStore } from '../app-advisor/chat-watcher-storage';
import {
  getCallerOwner,
  requireAuthorizedProjectIdentity,
  type AuthorizedProjectIdentity,
} from '../project-discovery/owner-policy';
import type * as ChatsListModule from '../project-discovery/chats-list';
import {
  readCommittedTaskSnapshot,
  readProjectEntries,
  readProjectIndexSnapshot,
} from '../project-discovery/sources';
import { isWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';

let mockLegacyPath: string;
let mockDirectory: string;
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string => mockLegacyPath,
  getDataDir: (): string => mockDirectory,
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../pipelines/pipeline-service', () => ({}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../lib/app-advisor-project-agent-access', () => ({}));
jest.mock('../lib/github-workflow-run-observer', () => ({}));
jest.mock('../lib/github-pull-request-observer', () => ({}));
jest.mock('../lib/github-pr-read-model', () => ({}));
jest.mock('../lib/github-broker', () => ({}));
jest.mock('../lib/github-broker/workflow-definitions', () => ({}));
jest.mock('../lib/github-broker/workflow-runs', () => ({}));
jest.mock('../lib/cowork-work-entries', () => ({}));
jest.mock('../lib/workspace-persistence', () => ({}));
jest.mock('../project-discovery/owner-policy');
jest.mock('../project-discovery/sources');
jest.mock('../project-discovery/chats-list', () => ({
  ...jest.requireActual<typeof ChatsListModule>(
    '../project-discovery/chats-list',
  ),
  listDiscoverableTaskIds: jest.fn(),
}));
jest.mock('../project-discovery/runtime-state');
jest.mock('../project-discovery/bots/target');
jest.mock('../lib/workspace-target-exclusion');
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): typeof mockAccount => mockAccount,
}));
const mockAccount = {
  initialize: (): Promise<void> => Promise.resolve(),
  whenIdle: (): Promise<void> => Promise.resolve(),
  accountEpoch: (): number => 1,
};
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';

const LEGACY_ALIAS = 'legacy-chat-project';
const personal: ProjectOwnerContext = { kind: 'personal' };
const recipient: Omit<CanonicalChatWatcherSetupInput, 'watchers'> = {
  destination: { projectId: 'recipient', worktreeId: 'task', chatId: 'root' },
  recipient: { kind: 'root' },
};

// Mirrors the canonical cowork ID mapping: an alias resolves to its project.
function identity(projectId: string): AuthorizedProjectIdentity {
  return {
    projectId: projectId === LEGACY_ALIAS ? 'project' : projectId,
    type: 'cowork',
    owner: personal,
    incarnation: 'project-generation',
    readiness: 'ready',
    synthetic: false,
    inventoryAuthority: 'ok',
  };
}

function chatSnapshot(taskId: string): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project',
    worktreeId: taskId,
    revision: 1,
    tabsFile: {
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-10-16T00:00:00Z',
          messages: [],
        },
      ],
    },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

let directory: string;
let canonicalPath: string;
beforeEach(async () => {
  jest.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'chat-watcher-alias-'));
  mockDirectory = directory;
  mockLegacyPath = join(directory, 'app-advisor-watchers.json');
  canonicalPath = join(directory, 'app-advisor-watchers-canonical.json');
  jest.mocked(getCallerOwner).mockResolvedValue(personal);
  jest
    .mocked(requireAuthorizedProjectIdentity)
    .mockImplementation((projectId) => Promise.resolve(identity(projectId)));
  jest.mocked(readProjectEntries).mockResolvedValue({
    version: 1,
    entries: [{ id: 'task', createdAt: '2026-10-16T00:00:00Z' }],
  });
  jest.mocked(isWorkspaceTargetRemovalPending).mockReturnValue(false);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function persistedRows(): Promise<unknown[]> {
  return existsSync(canonicalPath)
    ? await readCanonicalWatcherStore(canonicalPath)
    : [];
}

async function legacyFileWatchers(): Promise<unknown[]> {
  if (!existsSync(mockLegacyPath)) return [];
  const parsed: unknown = JSON.parse(await readFile(mockLegacyPath, 'utf8'));
  const watchers: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'watchers')
      : undefined;
  return Array.isArray(watchers) ? watchers.map((row: unknown) => row) : [];
}

it('refuses an explicit legacy project alias through setup and persists nothing', async () => {
  const service = getAppAdvisorWatcherService();
  const result = await service.setupCanonicalChatWatchers({
    ...recipient,
    watchers: [
      {
        trigger: 'project_new_chat_started',
        target: { projectId: 'project', taskId: 'task' },
      },
      {
        trigger: 'project_new_chat_started',
        target: { projectId: LEGACY_ALIAS, taskId: 'task' },
      },
    ],
  });
  expect(result).toEqual({
    ok: false,
    code: 'not_found',
    error: 'Watcher target was not found.',
    rejectedIndex: 1,
  });
  expect(jest.mocked(requireAuthorizedProjectIdentity)).toHaveBeenCalledWith(
    LEGACY_ALIAS,
    expect.anything(),
  );
  // The valid canonical sibling in the same batch must not be committed either.
  expect(await persistedRows()).toEqual([]);
  expect(await legacyFileWatchers()).toEqual([]);
  expect(await service.list()).toEqual([]);
});

it('persists the same explicit target when addressed by its canonical ID', async () => {
  const service = getAppAdvisorWatcherService();
  const result = await service.setupCanonicalChatWatchers({
    ...recipient,
    watchers: [
      {
        trigger: 'project_new_chat_started',
        target: { projectId: 'project', taskId: 'task' },
      },
    ],
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.results).toEqual([
    expect.objectContaining({ status: 'created' }),
  ]);
  expect((await service.list()).map((row) => row.id)).toEqual([
    result.results[0].watcher.id,
  ]);
  // Proves the alias test's empty-store assertions read the store setup writes.
  const rows = await persistedRows();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).toContain(result.results[0].watcher.id);
  expect(JSON.stringify(rows)).not.toContain(LEGACY_ALIAS);
});

function legacyScope(projectId: string): CanonicalChatWatcherSetupInput {
  return {
    ...recipient,
    watchers: [
      {
        trigger: 'standalone_new_chat_started',
        target: { kind: 'standalone_chat_project', projectId },
      },
    ],
  };
}

it('keeps canonical lookup for a legacy-spelled entry with its canonical ID', async () => {
  const service = getAppAdvisorWatcherService();
  const result = await service.setupCanonicalChatWatchers(
    legacyScope('project'),
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.results).toEqual([
    expect.objectContaining({ status: 'created' }),
  ]);
  expect((await service.list()).map((row) => row.id)).toEqual([
    result.results[0].watcher.id,
  ]);
  // A cowork project scope keeps its historical v1 encoding on disk.
  const stored = await legacyFileWatchers();
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).toContain('"projectId":"project"');
  expect(readProjectIndexSnapshot).not.toHaveBeenCalled();
});

it('refuses a legacy-spelled alias without persisting a watcher', async () => {
  const service = getAppAdvisorWatcherService();
  expect(
    await service.setupCanonicalChatWatchers(legacyScope(LEGACY_ALIAS)),
  ).toMatchObject({ ok: false, code: 'not_found', rejectedIndex: 0 });
  expect(jest.mocked(requireAuthorizedProjectIdentity)).toHaveBeenCalledWith(
    LEGACY_ALIAS,
    expect.anything(),
  );
  expect(await persistedRows()).toEqual([]);
  expect(await legacyFileWatchers()).toEqual([]);
  expect(await service.list()).toEqual([]);
});

function completion(projectId: string): CanonicalChatWatcherSetupInput {
  return {
    ...recipient,
    watchers: [
      {
        trigger: 'project_task_chat_completion',
        target: { projectId, taskId: 'task', chatId: 'chat' },
      },
    ],
  };
}

function inlineReservation(
  projectId: string,
): InlineChatWatcherReservationInput {
  return {
    ...recipient,
    target: { projectId, taskId: 'task', chatId: 'chat' },
    entries: [{ label: 'Inline' }],
    acceptedInputId: 'input',
    commandId: 'command',
  };
}

describe('explicit chat completion targets', () => {
  beforeEach(() => {
    jest
      .mocked(readCommittedTaskSnapshot)
      .mockImplementation((_project, taskId) =>
        Promise.resolve(chatSnapshot(taskId)),
      );
  });

  it('refuses a legacy alias through completion setup and persists nothing', async () => {
    const service = getAppAdvisorWatcherService();
    expect(
      await service.setupCanonicalChatWatchers(completion(LEGACY_ALIAS)),
    ).toMatchObject({ ok: false, code: 'not_found', rejectedIndex: 0 });
    expect(readCommittedTaskSnapshot).not.toHaveBeenCalled();
    expect(await persistedRows()).toEqual([]);
    expect(await legacyFileWatchers()).toEqual([]);
    expect(await service.list()).toEqual([]);
  });

  it('reserves an inline completion watcher only for the canonical ID', async () => {
    const service = getAppAdvisorWatcherService();
    expect(
      await service.reserveInlineChatWatchers(inlineReservation(LEGACY_ALIAS)),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(await persistedRows()).toEqual([]);
    expect(await legacyFileWatchers()).toEqual([]);
    expect(await service.list()).toEqual([]);

    const reserved = await service.reserveInlineChatWatchers(
      inlineReservation('project'),
    );
    if (!reserved.ok) throw new Error(reserved.error);
    expect(reserved.reservation.receipts).toEqual([
      expect.objectContaining({ disposition: 'created' }),
    ]);
    const stored = JSON.stringify(await persistedRows());
    expect(stored).toContain(reserved.reservation.reservationId);
    expect(stored).not.toContain(LEGACY_ALIAS);
  });
});
