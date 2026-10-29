import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  type ChatStateCommandPort,
  type ChatSendMessageRequest,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import type * as PathsModule from '../../lib/paths';
import type * as ChatServiceModule from '../../services/chat-service';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { handlePortalCommand } from '../portal-command-handlers';
import { portalFileReferences } from '../portal-file-references';

let mockRoot = '';
let mockSessionId = 'session-original';
let mockPort: ChatStateCommandPort;
const mockResolve = jest.fn(() =>
  Promise.resolve({
    workspaceId: 'cowork-workspace',
    entryId: 'entry-one',
    archivedInEntryId: null,
    isArchived: false,
  }),
);
const mockLegacySend = jest.fn();
const mockAuthorizeSend = jest.fn<Promise<void>, []>();
const mockBuildOptions = jest.fn<
  ReturnType<typeof ChatServiceModule.buildExistingTabDispatchOptions>,
  Parameters<typeof ChatServiceModule.buildExistingTabDispatchOptions>
>();
const mockDownload = jest.fn<
  Promise<Buffer>,
  [{ sessionId: string; attachmentId: string; signal?: AbortSignal }]
>();
const mockConsume = jest.fn<
  Promise<void>,
  [{ sessionId: string; attachmentId: string }]
>();

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getCoworkWorkspaceRootDir: (): string => mockRoot,
  getWorktreeAttachmentsDir: (): string => join(mockRoot, 'code-attachments'),
}));
jest.mock('../../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (
    ...args: Parameters<
      typeof ChatServiceModule.buildExistingTabDispatchOptions
    >
  ): ReturnType<typeof ChatServiceModule.buildExistingTabDispatchOptions> =>
    mockBuildOptions(...args),
  assertWorktreeChatSendNotSplitLocked: jest.fn(),
  sendWorktreeChatMessage: jest.fn(),
}));
jest.mock('../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: (): ReturnType<typeof mockResolve> =>
    mockResolve(),
  sendStandaloneChatMessage: (...args: unknown[]): unknown =>
    mockLegacySend(...args),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(false),
}));
jest.mock('../../lib/default-model-lane-resolver', () => ({
  resolveConcreteModelDispatchability: (): Promise<string> =>
    Promise.resolve('dispatchable'),
  resolveLaneAwareDefaultSelection: (): Promise<{
    outcome: 'resolved';
    selection: { model: string };
  }> =>
    Promise.resolve({
      outcome: 'resolved',
      selection: { model: 'gpt-5.2-codex' },
    }),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): ChatStateCommandPort => mockPort,
}));
jest.mock('../portal-session-manager', () => ({
  getCanopyPortalState: (): { sessionId: string } => ({
    sessionId: mockSessionId,
  }),
}));
jest.mock('../canopy-portal-client', () => ({
  downloadPortalChatAttachment: (
    input: Parameters<typeof mockDownload>[0],
  ): Promise<Buffer> => mockDownload(input),
  consumePortalChatAttachment: (
    input: Parameters<typeof mockConsume>[0],
  ): Promise<void> => mockConsume(input),
}));
jest.mock('../portal-snapshot-builders', () => ({
  buildPortalSnapshot: jest.fn(),
}));

const scope = { projectId: 'cowork-workspace', worktreeId: 'entry-one' };
const bytes = Buffer.from('Original attachment bytes 日本語');
const ref = {
  attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
  filename: 'árvore-日本語.txt',
  mediaType: 'text/plain',
  size: bytes.length,
  contentSha256: createHash('sha256').update(bytes).digest('hex'),
  storageKind: 'blob' as const,
  source: '/never-fetch-browser-source',
};

function sendCommand(
  overrides: Partial<
    PortalCommandPayloadMap['portal.standalone_chat.send']
  > = {},
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.standalone_chat.send']
> {
  return {
    id: 'cowork-send-original',
    sequence: 2,
    type: 'portal.standalone_chat.send',
    target: { standaloneChatLocalId: 'chat-one' },
    payload: {
      projectLocalId: scope.projectId,
      chatId: 'chat-one',
      userMessageId: 'message-original',
      message: 'Read the original',
      cloudAttachments: [ref],
      ...overrides,
    },
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(15_000);

describe('registered Cowork attachment sends', () => {
  let directory = '';
  let service: ChatStateService;
  let repository: ChatStateV2Repository;
  let runtime: ReturnType<typeof createDesktopRuntime>;
  let events: PortalEventEnvelope[];
  const dispatch = jest.fn<Promise<void>, [ChatSendMessageRequest]>();
  const authorizedModels: unknown[] = [];

  async function send(
    command: PortalCommandEnvelope = sendCommand(),
    authorized = true,
  ): Promise<void> {
    const sessionId = mockSessionId;
    await handlePortalCommand(command, {
      chatDispatcher: runtime,
      sessionId,
      pairingCode: null,
      canReadAssets: (): boolean => authorized && mockSessionId === sessionId,
      getWindow: () => null,
      markAuthenticated: jest.fn(),
      stop: (): Promise<void> => Promise.resolve(),
      enqueueEvent: (event): void => {
        events.push(event);
      },
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    portalFileReferences.clear();
    events = [];
    authorizedModels.length = 0;
    mockSessionId = 'session-original';
    directory = await mkdtemp(join(tmpdir(), 'cowork-portal-send-'));
    mockRoot = join(directory, 'workspace-root');
    registerWorkspaceTypes(new Map([[scope.projectId, 'cowork']]));
    initClaudeModels([{ id: 'claude-opus-4-6', label: 'Opus' }]);
    initCodexModels([{ id: 'gpt-5.2-codex', label: 'Codex' }]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    dispatch.mockReset().mockResolvedValue(undefined);
    mockAuthorizeSend.mockReset().mockResolvedValue(undefined);
    service = new ChatStateService({
      repository,
      dispatch,
      steer: (): Promise<boolean> => Promise.resolve(false),
      cleanupSession: (): Promise<void> => Promise.resolve(),
      onInputPickup: (): Promise<void> => Promise.resolve(),
      authorizeSend: ({ tab }): Promise<void> => {
        authorizedModels.push({
          model: tab.model,
          providerType: tab.providerType,
        });
        return mockAuthorizeSend();
      },
      recordDiagnostic: jest.fn(),
    });
    mockPort = service;
    runtime = createDesktopRuntime({
      chatCommandPort: service,
      getChatStatePort: () => mockPort,
      chatServices: { getPort: () => mockPort },
    });
    await service.command({
      schemaVersion: 1,
      commandId: 'cowork-create',
      ...scope,
      command: {
        type: 'chat.create_tab',
        tabId: 'chat-one',
        title: 'Cowork',
        model: 'claude-opus-4-6',
        providerType: 'claude',
      },
    });
    registerWorkspaceTypes(new Map([[scope.projectId, 'cowork']]));
    mockResolve.mockResolvedValue({
      workspaceId: scope.projectId,
      entryId: scope.worktreeId,
      archivedInEntryId: null,
      isArchived: false,
    });
    mockBuildOptions.mockImplementation(async () => {
      const state = await service.getState(scope);
      const tab = state.tabsFile.tabs.find(({ id }) => id === 'chat-one');
      return {
        ...(tab?.model ? { model: tab.model } : {}),
        ...(tab?.providerType ? { providerType: tab.providerType } : {}),
        ...(tab?.modelConfig ? { modelConfig: tab.modelConfig } : {}),
      };
    });
    mockDownload.mockResolvedValue(bytes);
    mockConsume.mockImplementation(async () => {
      expect(
        await service.getCommandReceipt({
          ...scope,
          commandId: 'cowork-send-original',
        }),
      ).not.toBeNull();
      mockDownload.mockRejectedValue(new Error('Blob was consumed'));
    });
  });

  afterEach(async () => {
    portalFileReferences.clear();
    await runtime.shutdown();
    await repository.drainAll();
    await rm(directory, { recursive: true, force: true });
    registerWorkspaceTypes(new Map());
  });

  it('persists exact originals in the Cowork directory before consuming accepted blobs', async () => {
    const fileReferences = [
      { displayPath: 'notes.md', absolutePath: join(mockRoot, 'notes.md') },
    ];
    await send(
      sendCommand({
        fileReferences: fileReferences.map((reference) =>
          portalFileReferences.mint(
            { sessionId: mockSessionId, ...scope },
            reference,
          ),
        ),
        modelConfig: { thinkingLevel: 'high', fastMode: true },
        inputMode: 'voice',
      }),
    );
    expect(mockLegacySend).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: {
          ok: true,
          chatId: 'chat-one',
          userMessageId: 'message-original',
          outcome: 'applied',
        },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const request = dispatch.mock.calls[0][0];
    expect(request).toMatchObject({
      ...scope,
      chatId: 'chat-one',
      userMessageId: 'message-original',
      fileReferences,
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      inputMode: 'voice',
    });
    const path = request.attachmentPaths?.[0];
    expect(path).toBeDefined();
    if (!path) throw new Error('Expected the persisted original attachment');
    expect(dirname(dirname(path))).toBe(
      getCoworkManagedSubdir(mockRoot, 'attachments'),
    );
    expect(basename(path)).toBe(ref.filename);
    expect(await readFile(path)).toEqual(bytes);
    expect(mockDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-original',
        attachmentId: ref.attachmentId,
      }),
    );
    expect(mockConsume).toHaveBeenCalledTimes(1);
    const state = await service.getState(scope);
    expect(state.tabsFile.tabs[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'message-original', role: 'user' }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'portal.command.completed',
          commandId: 'cowork-send-original',
        }),
      ]),
    );
  });

  it('replays the original receipt after consumption and after a pairing-session change', async () => {
    await send();
    mockDownload.mockClear();
    mockSessionId = 'session-repaired';
    await send();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(events.at(-1)?.payload).toMatchObject({
      result: { outcome: 'already_applied', messageId: 'message-original' },
    });
  });

  it.each(['cowork', 'code'] as const)(
    'replays an accepted %s logical send through a new transport attempt without fetching consumed blobs',
    async (surface) => {
      let original: PortalCommandEnvelope = sendCommand();
      if (surface === 'code') {
        registerWorkspaceTypes(new Map([[scope.projectId, 'single-repo']]));
        original = {
          ...original,
          type: 'portal.chat.send',
          target: {
            workspaceLocalId: scope.projectId,
            worktreeLocalId: scope.worktreeId,
            chatLocalId: 'chat-one',
          },
          payload: {
            ...scope,
            chatId: 'chat-one',
            userMessageId: 'message-original',
            text: 'Read the original',
            cloudAttachments: [ref],
          },
        };
      }
      await send(original);
      mockDownload.mockClear();
      await send({ ...original, id: 'send-after-expiration', sequence: 3 });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(mockDownload).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        type: 'portal.command.completed',
        commandId: 'send-after-expiration',
        payload: {
          result: {
            commandId: 'send-after-expiration',
            outcome: 'already_applied',
            entityId: 'chat-one',
            messageId: 'message-original',
          },
        },
      });
      expect(
        (await service.getState(scope)).tabsFile.tabs[0].messages.filter(
          ({ role }) => role === 'user',
        ),
      ).toHaveLength(1);
    },
  );

  it('allows a new transport attempt after a confirmed uncommitted failure', async () => {
    mockDownload.mockRejectedValueOnce(new Error('Temporary download failure'));
    await send();
    expect(dispatch).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('portal.command.failed');
    mockConsume.mockImplementation(() => {
      mockDownload.mockRejectedValue(new Error('Blob was consumed'));
      return Promise.resolve();
    });
    await send({ ...sendCommand(), id: 'retry-after-failure', sequence: 3 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe('portal.command.completed');
    expect(
      (await service.getState(scope)).tabsFile.tabs[0].messages.filter(
        ({ role }) => role === 'user',
      ),
    ).toHaveLength(1);
  });

  it('recovers logical-send receipts from disk before fetching consumed originals', async () => {
    await send();
    await repository.drainAll();
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    service = new ChatStateService({
      repository,
      dispatch,
      steer: (): Promise<boolean> => Promise.resolve(false),
      cleanupSession: (): Promise<void> => Promise.resolve(),
      onInputPickup: (): Promise<void> => Promise.resolve(),
      authorizeSend: (): Promise<void> => Promise.resolve(),
      recordDiagnostic: jest.fn(),
    });
    mockPort = service;
    mockDownload.mockClear();
    await send({ ...sendCommand(), id: 'retry-after-restart', sequence: 3 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.completed',
      commandId: 'retry-after-restart',
      payload: { result: { outcome: 'already_applied' } },
    });
  });

  it('rejects a logical receipt whose message binding does not match', async () => {
    await send();
    const receipt = await service.getCommandReceipt({
      ...scope,
      commandId: 'cowork-send-original',
    });
    if (!receipt) throw new Error('Expected the original durable receipt');
    jest.spyOn(repository, 'getPortalSendReceipt').mockResolvedValue({
      ...receipt,
      messageId: 'a-different-message',
    });
    mockDownload.mockClear();
    mockConsume.mockClear();
    await send({ ...sendCommand(), id: 'corrupt-binding-retry', sequence: 3 });
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['text', 'attachment', 'target', 'command'] as const)(
    'rejects logical replay with changed %s before touching consumed blobs',
    async (change) => {
      await send();
      mockDownload.mockClear();
      mockConsume.mockClear();
      const retry = {
        ...sendCommand(
          change === 'text'
            ? { message: 'Different message' }
            : change === 'attachment'
              ? { cloudAttachments: [{ ...ref, filename: 'different.txt' }] }
              : {},
        ),
        id: change === 'command' ? 'cowork-send-original' : 'altered-retry',
        sequence: 3,
      };
      if (change === 'target') {
        retry.target = {
          ...retry.target,
          chatLocalId: 'a-different-target',
        };
      }
      if (change === 'command') {
        retry.payload.message = 'Changed same transport command';
      }
      await send(retry);
      expect(events.at(-1)).toMatchObject({
        type: 'portal.command.failed',
        payload: { error: { code: 'invalid_payload' } },
      });
      expect(mockDownload).not.toHaveBeenCalled();
      expect(mockConsume).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not treat an arbitrary preexisting message id as a portal receipt', async () => {
    await service.command({
      schemaVersion: 1,
      ...scope,
      commandId: 'nonportal-send',
      origin: 'desktop',
      command: {
        type: 'chat.send_message',
        chatId: 'chat-one',
        userMessageId: 'message-original',
        text: 'An unrelated local message',
      },
    });
    dispatch.mockClear();
    await send();
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('serializes distinct transport attempts for one logical send before downloading twice', async () => {
    let releaseDispatch: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    dispatch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
          markEntered?.();
        }),
    );
    const first = send();
    await entered;
    const second = send({
      ...sendCommand(),
      id: 'concurrent-retry',
      sequence: 3,
    });
    releaseDispatch?.();
    await Promise.all([first, second]);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.completed',
      commandId: 'concurrent-retry',
      payload: { result: { outcome: 'already_applied' } },
    });
  });

  it.each(['cowork', 'code'] as const)(
    'refuses %s sends revoked at the final durable publication boundary',
    async (surface) => {
      let command: PortalCommandEnvelope = sendCommand();
      if (surface === 'code') {
        registerWorkspaceTypes(new Map([[scope.projectId, 'single-repo']]));
        command = {
          ...command,
          type: 'portal.chat.send',
          target: {
            workspaceLocalId: scope.projectId,
            worktreeLocalId: scope.worktreeId,
            chatLocalId: 'chat-one',
          },
          payload: {
            ...scope,
            chatId: 'chat-one',
            userMessageId: 'message-original',
            text: 'Read the original',
            cloudAttachments: [ref],
          },
        };
      }
      const transact = repository.transactWith.bind(repository);
      const boundary = jest.spyOn(repository, 'transactWith');
      boundary.mockImplementation((target, build, options) =>
        transact(target, build, {
          ...options,
          beforePublish: (): void => {
            mockSessionId = 'session-repaired';
            options.beforePublish?.();
          },
        }),
      );
      await send(command);
      expect(dispatch).not.toHaveBeenCalled();
      expect(mockConsume).not.toHaveBeenCalled();
      expect(
        await service.getCommandReceipt({ ...scope, commandId: command.id }),
      ).toBeNull();
      expect(
        (await service.getState(scope)).tabsFile.tabs[0].messages,
      ).toHaveLength(0);
      expect(events.at(-1)?.type).toBe('portal.command.failed');
      const attachmentsRoot =
        surface === 'cowork'
          ? getCoworkManagedSubdir(mockRoot, 'attachments')
          : join(mockRoot, 'code-attachments');
      const directories = await readdir(attachmentsRoot);
      const files = await Promise.all(
        directories.map((entry) => readdir(join(attachmentsRoot, entry))),
      );
      expect(files.flat()).toEqual([]);
      boundary.mockRestore();
    },
  );

  it('rejects a concurrent canonical transport claim with a different logical message', async () => {
    let releaseDispatch: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    dispatch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
          markEntered?.();
        }),
    );
    const fingerprint = createHash('sha256')
      .update('canonical-send')
      .digest('hex');
    const first = service.command(
      {
        schemaVersion: 1,
        commandId: 'shared-transport-id',
        ...scope,
        origin: 'portal',
        command: {
          type: 'chat.send_message',
          chatId: 'chat-one',
          userMessageId: 'message-original',
          text: 'Read the original',
        },
      },
      {
        portalSend: {
          chatId: 'chat-one',
          userMessageId: 'message-original',
          fingerprint,
        },
      },
    );
    await entered;
    const second = service.command(
      {
        schemaVersion: 1,
        commandId: 'shared-transport-id',
        ...scope,
        origin: 'portal',
        command: {
          type: 'chat.send_message',
          chatId: 'chat-one',
          userMessageId: 'message-other',
          text: 'Read the original',
        },
      },
      {
        portalSend: {
          chatId: 'chat-one',
          userMessageId: 'message-other',
          fingerprint,
        },
      },
    );
    releaseDispatch?.();
    const [accepted, refused] = await Promise.all([first, second]);
    expect(accepted.outcome).toBe('applied');
    expect(refused.outcome).toBe('rejected');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (await service.getState(scope)).tabsFile.tabs[0].messages,
    ).toHaveLength(1);
  });

  it('deduplicates pending concurrent commands without losing the persisted original', async () => {
    let releaseDispatch: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    dispatch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
          markEntered?.();
        }),
    );
    const sends = Promise.all([send(), send()]);
    await entered;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockConsume).not.toHaveBeenCalled();
    releaseDispatch?.();
    await sends;
    const path = dispatch.mock.calls[0][0].attachmentPaths?.[0];
    if (!path) throw new Error('Expected the persisted original attachment');
    expect(await readFile(path)).toEqual(bytes);
    const attachmentsRoot = getCoworkManagedSubdir(mockRoot, 'attachments');
    const attachmentDirs = await readdir(attachmentsRoot);
    const files = await Promise.all(
      attachmentDirs.map((attachmentDir) =>
        readdir(join(attachmentsRoot, attachmentDir)),
      ),
    );
    expect(files.flat()).toEqual([ref.filename]);
  });

  it('rejects uncommitted old-session blobs without consuming or persisting a message', async () => {
    mockSessionId = 'session-repaired';
    mockDownload.mockImplementation(({ sessionId }) =>
      sessionId === 'session-original'
        ? Promise.resolve(bytes)
        : Promise.reject(new Error('Old-session blob')),
    );
    await send();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(events.at(-1)?.payload).toMatchObject({
      error: { code: 'execution_failed' },
      retryable: true,
    });
    expect(
      (await service.getState(scope)).tabsFile.tabs[0].messages,
    ).toHaveLength(0);
  });

  it('ignores a provider-only override when the persisted tab owns a model', async () => {
    await send(sendCommand({ providerType: 'codex' }));
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      model: 'claude-opus-4-6',
      providerType: 'claude',
    });
  });

  it.each([
    ['cowork', 'download'],
    ['cowork', 'authorization'],
    ['cowork', 'commit'],
    ['code', 'download'],
    ['code', 'authorization'],
    ['code', 'commit'],
  ] as const)(
    'refuses %s sends revoked during %s before committing or consuming',
    async (surface, stage) => {
      let command: PortalCommandEnvelope = sendCommand();
      if (surface === 'code') {
        registerWorkspaceTypes(new Map([[scope.projectId, 'single-repo']]));
        command = {
          ...sendCommand(),
          type: 'portal.chat.send',
          target: {
            workspaceLocalId: scope.projectId,
            worktreeLocalId: scope.worktreeId,
            chatLocalId: 'chat-one',
          },
          payload: {
            ...scope,
            chatId: 'chat-one',
            userMessageId: 'message-original',
            text: 'Read the original',
            cloudAttachments: [ref],
          },
        };
      }
      if (stage === 'download') {
        mockDownload.mockImplementationOnce(async () => {
          await Promise.resolve();
          mockSessionId = '';
          return bytes;
        });
      } else if (stage === 'authorization') {
        mockAuthorizeSend.mockImplementationOnce(async () => {
          await Promise.resolve();
          mockSessionId = 'session-repaired';
        });
      } else {
        const transactWith = repository.transactWith.bind(repository);
        jest
          .spyOn(repository, 'transactWith')
          .mockImplementationOnce(async (...args) => {
            await Promise.resolve();
            mockSessionId = '';
            return transactWith(...args);
          });
      }
      await send(command);
      expect(dispatch).not.toHaveBeenCalled();
      expect(mockConsume).not.toHaveBeenCalled();
      expect(
        (await service.getState(scope)).tabsFile.tabs[0].messages,
      ).toHaveLength(0);
      expect(await repository.getReceipt(scope, command.id)).toBeUndefined();
      expect(events.at(-1)?.type).toBe('portal.command.failed');
      const attachmentsRoot =
        surface === 'cowork'
          ? getCoworkManagedSubdir(mockRoot, 'attachments')
          : join(mockRoot, 'code-attachments');
      const directories = await readdir(attachmentsRoot);
      const files = await Promise.all(
        directories.map((directory) =>
          readdir(join(attachmentsRoot, directory)),
        ),
      );
      expect(files.flat()).toEqual([]);
    },
  );

  it('authorizes and commits the explicit model and provider with the message', async () => {
    await send(
      sendCommand({
        model: 'gpt-5.2-codex',
        providerType: 'codex',
        thinkingLevel: 'low',
        modelConfig: { thinkingLevel: 'high' },
      }),
    );
    expect(authorizedModels).toEqual([
      { model: 'gpt-5.2-codex', providerType: 'codex' },
    ]);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.2-codex',
      providerType: 'codex',
      modelConfig: { thinkingLevel: 'high' },
    });
    expect((await service.getState(scope)).tabsFile.tabs[0]).toMatchObject({
      model: 'gpt-5.2-codex',
      providerType: 'codex',
    });
  });

  it('resolves a provider default for a model-less canonical tab', async () => {
    const tabsFile = await service.getCompatibilityTabs(scope);
    await service.replaceCompatibilityTabs(scope, {
      ...tabsFile,
      tabs: tabsFile.tabs.map((tab) => ({
        ...tab,
        model: undefined,
        providerType: undefined,
      })),
    });
    await send(sendCommand({ providerType: 'codex' }));
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.2-codex',
      providerType: 'codex',
    });
  });

  it('clears foreign-provider session and settings in the message commit', async () => {
    const tabsFile = await service.getCompatibilityTabs(scope);
    await service.replaceCompatibilityTabs(scope, {
      ...tabsFile,
      tabs: tabsFile.tabs.map((tab) => ({
        ...tab,
        sdkSessionId: 'old-claude-session',
        executionHarness: 'claude',
        modelConfig: { thinkingLevel: 'low', fastMode: true },
      })),
    });
    await send(sendCommand({ model: 'gpt-5.2-codex', providerType: 'codex' }));
    const request = dispatch.mock.calls[0][0];
    expect(request).not.toHaveProperty('sdkSessionId');
    expect(request).not.toHaveProperty('executionHarness');
    expect(request).not.toHaveProperty('modelConfig');
    const tab = (await service.getState(scope)).tabsFile.tabs[0];
    expect(tab).toMatchObject({
      model: 'gpt-5.2-codex',
      providerType: 'codex',
    });
    expect(tab).not.toHaveProperty('sdkSessionId');
    expect(tab).not.toHaveProperty('executionHarness');
    expect(tab).not.toHaveProperty('modelConfig');
  });

  it.each(['missing', 'archived', 'unauthorized', 'identity'] as const)(
    'fails closed for %s targets without silently dropping uploads',
    async (kind) => {
      if (kind === 'missing')
        mockResolve.mockResolvedValue({
          workspaceId: scope.projectId,
          entryId: '',
          archivedInEntryId: null,
          isArchived: false,
        });
      if (kind === 'archived')
        mockResolve.mockResolvedValue({
          workspaceId: scope.projectId,
          entryId: scope.worktreeId,
          archivedInEntryId: null,
          isArchived: true,
        });
      await send(
        sendCommand(kind === 'identity' ? { userMessageId: undefined } : {}),
        kind !== 'unauthorized',
      );
      expect(mockLegacySend).not.toHaveBeenCalled();
      expect(mockDownload).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(events.at(-1)?.payload).toMatchObject({
        error: { code: 'invalid_target' },
      });
    },
  );
});
