import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  ChatSessionCloudExportDeleteResponse,
  ChatSessionCloudExportListRequest,
  ChatSessionCloudExportListResponse,
  ChatSessionExportRequest,
  ChatSessionExportResponse,
  ChatSessionImportInspectRequest,
  ChatSessionImportInspectResponse,
  ChatSessionImportRequest,
  ChatSessionImportResponse,
} from '@canopy/desktop-shared/types';
import type { CoreChatTransferHost } from '../core-chat-transfer-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

type Grant = 'core.chat.read' | 'core.chat.write';

function callerWith(
  overrides: Partial<{
    authorityId: string;
    interfaceKind: 'desktop' | 'portal';
    grants: Grant[];
  }> = {},
): {
  principalId: string;
  clientInstanceId: string;
  authorityId: string;
  interfaceKind: 'desktop' | 'portal';
  grants: Grant[];
} {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'test',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.chat.read', 'core.chat.write'],
    ...overrides,
  };
}

const inspection: ChatSessionImportInspectResponse = {
  exportId: 'exp-1',
  manifestSummary: {
    title: 'Chat',
    provider: 'claude',
    exportedAt: '2026-11-05T10:00:00.000Z',
    workspaceType: 'cowork',
    repoCount: 0,
    repos: [],
  },
  workspaceSummary: {
    workspaceId: 'ws-1',
    workspaceName: 'Cowork',
    workspaceType: 'cowork',
    repoCount: 0,
    repos: [],
  },
  match: 'exact',
  workspaceTypeCompatible: true,
  missingRepos: [],
  warnings: [],
};

const imported: ChatSessionImportResponse = {
  projectId: 'ws-1',
  worktreeId: 'entry-1',
  chatId: 'chat-new',
  warnings: [],
  stagingRetained: false,
};

describe('chat transfer in the desktop core (CAN-4113)', () => {
  let host: {
    list: jest.Mock<
      Promise<ChatSessionCloudExportListResponse>,
      [ChatSessionCloudExportListRequest]
    >;
    export: jest.Mock<
      Promise<ChatSessionExportResponse>,
      [ChatSessionExportRequest]
    >;
    delete: jest.Mock<Promise<ChatSessionCloudExportDeleteResponse>, [string]>;
    inspect: jest.Mock<
      Promise<ChatSessionImportInspectResponse>,
      [ChatSessionImportInspectRequest]
    >;
    import: jest.Mock<
      Promise<ChatSessionImportResponse>,
      [ChatSessionImportRequest]
    >;
    discard: jest.Mock<Promise<void>, [string]>;
  };
  let runtime: ReturnType<typeof createDesktopRuntime>;

  beforeEach(() => {
    host = {
      list: jest.fn<
        Promise<ChatSessionCloudExportListResponse>,
        [ChatSessionCloudExportListRequest]
      >(() =>
        Promise.resolve({
          data: [
            {
              id: 'exp-1',
              title: 'Chat',
              workspaceName: 'Cowork',
              workspaceType: 'cowork',
              repos: [],
              sizeBytes: 10,
              createdAt: '2026-11-05T10:00:00.000Z',
              updatedAt: '2026-11-05T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      ),
      export: jest.fn<
        Promise<ChatSessionExportResponse>,
        [ChatSessionExportRequest]
      >(() =>
        Promise.resolve({
          exportId: 'exp-1',
          title: 'Chat',
          sizeBytes: 10,
          warnings: [],
        }),
      ),
      delete: jest.fn<Promise<ChatSessionCloudExportDeleteResponse>, [string]>(
        () => Promise.resolve({ deleted: true as const }),
      ),
      inspect: jest.fn<
        Promise<ChatSessionImportInspectResponse>,
        [ChatSessionImportInspectRequest]
      >(() => Promise.resolve(inspection)),
      import: jest.fn<
        Promise<ChatSessionImportResponse>,
        [ChatSessionImportRequest]
      >(() => Promise.resolve(imported)),
      discard: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    };
    const transferHost: CoreChatTransferHost = host;
    runtime = createDesktopRuntime({ chatTransferHost: transferHost });
  });

  afterEach(async () => {
    await runtime.shutdown();
  });

  function exportChat(
    key: string,
    chatId: string,
    caller = callerWith(),
  ): Promise<unknown> {
    return runtime.instruction(
      'core.chat.transfer.export',
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId,
        _meta: { idempotencyKey: key },
      },
      { caller, metadata: { idempotencyKey: key } },
    );
  }

  it('exports once per key', async () => {
    const expected = {
      transferId: 'exp-1',
      title: 'Chat',
      sizeBytes: 10,
      warnings: [],
    };
    await expect(exportChat('k1', 'c1')).resolves.toEqual(expected);
    await expect(exportChat('k1', 'c1')).resolves.toEqual(expected);
    expect(host.export).toHaveBeenCalledTimes(1);
    expect(host.export).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c1',
    });
  });

  it('refuses a reused key with other params', async () => {
    await exportChat('k1', 'c1');
    const refusal = exportChat('k1', 'c2');
    await expect(refusal).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(refusal).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.chat.transfer.idempotencyKeyReused',
      },
    });
    expect(host.export).toHaveBeenCalledTimes(1);
  });

  it('imports once per key', async () => {
    const params = {
      transferId: 'exp-1',
      workspaceId: 'ws-1',
      installMissing: true,
      _meta: { idempotencyKey: 'k2' },
    };
    const options = {
      caller: callerWith(),
      metadata: { idempotencyKey: 'k2' },
    };
    await expect(
      runtime.instruction('core.chat.transfer.import', params, options),
    ).resolves.toEqual(imported);
    await expect(
      runtime.instruction('core.chat.transfer.import', params, options),
    ).resolves.toEqual(imported);
    expect(host.import).toHaveBeenCalledTimes(1);
    expect(host.import).toHaveBeenCalledWith({
      exportId: 'exp-1',
      workspaceId: 'ws-1',
      installMissing: true,
    });
  });

  it('inspects as a write and lists as a read', async () => {
    const params = { transferId: 'exp-1', workspaceId: 'ws-1' };
    await expect(
      runtime.instruction('core.chat.transfer.import.inspect', params, {
        caller: callerWith({ grants: ['core.chat.read'] }),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(host.inspect).not.toHaveBeenCalled();

    const inspected = await runtime.instruction(
      'core.chat.transfer.import.inspect',
      params,
      { caller: callerWith({ grants: ['core.chat.write'] }) },
    );
    expect(host.inspect).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      exportId: 'exp-1',
    });
    expect(inspected).toMatchObject({ transferId: 'exp-1' });
    expect(inspected).not.toHaveProperty('exportId');

    const listed = await runtime.query(
      'core.chat.transfer.list',
      { query: 'abc', limit: 5 },
      { caller: callerWith({ grants: ['core.chat.read'] }) },
    );
    expect(host.list).toHaveBeenCalledWith({ q: 'abc', limit: 5 });
    expect(listed.transfers[0]).toMatchObject({ transferId: 'exp-1' });
    expect(listed.transfers[0]).not.toHaveProperty('id');
  });

  it("keeps the host's message and stays local", async () => {
    const failure = new Error(
      'Sign in to Canopy Cloud to transfer chat sessions.',
    );
    host.export.mockRejectedValue(failure);
    const rejection = await exportChat('k3', 'c1').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(CanopyOperationError);
    if (!(rejection instanceof CanopyOperationError))
      throw new Error('Expected a CanopyOperationError');
    expect(rejection.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.chat.transfer.failed',
      message: 'Sign in to Canopy Cloud to transfer chat sessions.',
      retry: { kind: 'never' },
    });
    expect(rejection.runtimeCause).toBe(failure);

    host.export.mockClear();
    await expect(
      exportChat('k4', 'c1', callerWith({ interfaceKind: 'portal' })),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      exportChat('k5', 'c1', callerWith({ authorityId: 'other-authority' })),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(host.export).not.toHaveBeenCalled();
  });

  it('refuses a key reused across operations', async () => {
    const options = {
      caller: callerWith(),
      metadata: { idempotencyKey: 'k8' },
    };
    await expect(
      runtime.instruction(
        'core.chat.transfer.delete',
        { transferId: 'exp-1', _meta: { idempotencyKey: 'k8' } },
        options,
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(
      runtime.instruction(
        'core.chat.transfer.import.discard',
        { transferId: 'exp-1', _meta: { idempotencyKey: 'k8' } },
        options,
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.chat.transfer.idempotencyKeyReused',
        retry: { kind: 'never' },
      },
    });
    expect(host.discard).not.toHaveBeenCalled();
  });

  it('discards and deletes through the host', async () => {
    const keyed = (
      key: string,
    ): {
      caller: ReturnType<typeof callerWith>;
      metadata: { idempotencyKey: string };
    } => ({ caller: callerWith(), metadata: { idempotencyKey: key } });
    await expect(
      runtime.instruction(
        'core.chat.transfer.import.discard',
        { transferId: 'exp-1', _meta: { idempotencyKey: 'k6' } },
        keyed('k6'),
      ),
    ).resolves.toEqual({ discarded: true });
    expect(host.discard).toHaveBeenCalledWith('exp-1');
    await expect(
      runtime.instruction(
        'core.chat.transfer.delete',
        { transferId: 'exp-1', _meta: { idempotencyKey: 'k7' } },
        keyed('k7'),
      ),
    ).resolves.toEqual({ deleted: true });
    expect(host.delete).toHaveBeenCalledWith('exp-1');
  });
});
