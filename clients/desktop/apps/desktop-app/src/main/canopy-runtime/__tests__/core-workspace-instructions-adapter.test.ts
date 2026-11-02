import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { UnsupportedInstructionLayoutError } from '@canopy/core-runtime/node/workspace/instruction-files';
import type { CoreWorkspaceInstructionsHost } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { workspaceInstructionsTelemetrySource } from '../core-workspace-instructions-adapter';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';
import {
  getWorkspaceInstructions,
  updateWorkspaceInstructions,
} from '../workspace-instructions-dispatch';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));

const DESKTOP_GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
];

function caller(
  overrides: Partial<CanopyCallerDescriptor> = {},
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
    ...overrides,
  };
}

interface FakeHost {
  host: CoreWorkspaceInstructionsHost;
  read: jest.Mock<Promise<string>, [string]>;
  write: jest.Mock<Promise<void>, [string, string, CanopyCallerDescriptor]>;
}

function fakeHost(): FakeHost {
  const files = new Map<string, string>();
  const read = jest.fn<Promise<string>, [string]>((workspaceId) =>
    Promise.resolve(files.get(workspaceId) ?? ''),
  );
  const write = jest.fn<
    Promise<void>,
    [string, string, CanopyCallerDescriptor]
  >((workspaceId, content) => {
    files.set(workspaceId, content);
    return Promise.resolve();
  });
  return {
    read,
    write,
    host: {
      read: (workspaceId) => read(workspaceId),
      write: (workspaceId, content, writer) =>
        write(workspaceId, content, writer),
      isInvalidWorkspaceId: (error) =>
        error instanceof IdentifierValidationError,
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection.');
}

let runtime: DesktopCanopyDispatcher | undefined;
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('core.workspace.instructions on the desktop dispatcher', () => {
  it('requires core.workspace.read for get and core.workspace.write for update', async () => {
    const fake = fakeHost();
    runtime = createDesktopRuntime({ workspaceInstructionsHost: fake.host });
    const desktop = caller();
    // The interface grants alone cannot write; the handler grants it per call.
    await expect(
      runtime.instruction(
        'core.workspace.instructions.update',
        { workspaceId: 'ws-1', content: '# x' },
        { caller: desktop },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.query(
        'core.workspace.instructions.get',
        { workspaceId: 'ws-1' },
        { caller: { ...desktop, grants: ['core.workspace.write'] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.write).not.toHaveBeenCalled();

    await updateWorkspaceInstructions(runtime, desktop, 'ws-1', '# Saved');
    await expect(
      getWorkspaceInstructions(runtime, desktop, 'ws-1'),
    ).resolves.toBe('# Saved');
    expect(fake.write).toHaveBeenCalledWith(
      'ws-1',
      '# Saved',
      expect.objectContaining({ grants: ['core.workspace.write'] }),
    );
  });

  it('rejects an idempotency key and unknown params before the handler', async () => {
    const fake = fakeHost();
    runtime = createDesktopRuntime({ workspaceInstructionsHost: fake.host });
    const writer = caller({ grants: ['core.workspace.write'] });
    await expect(
      runtime.instruction(
        'core.workspace.instructions.update',
        { workspaceId: 'ws-1', content: 'x' },
        { caller: writer, metadata: { idempotencyKey: 'key-1' } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    const unknownPathParams = { workspaceId: 'ws-1', content: 'x' };
    // Preserve the malformed legacy payload while keeping the dispatcher call typed.
    Reflect.set(unknownPathParams, 'path', '/etc/passwd');
    await expect(
      runtime.instruction(
        'core.workspace.instructions.update',
        unknownPathParams,
        { caller: writer },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    const invalidContentParams = { workspaceId: 'ws-1', content: 'x' };
    // Keep the intentionally invalid number on the wire, not in the typed fixture.
    Reflect.set(invalidContentParams, 'content', 42);
    await expect(
      runtime.instruction(
        'core.workspace.instructions.update',
        invalidContentParams,
        { caller: writer },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Invalid operation parameters.',
      },
    });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it('types host failures and keeps the original error as the runtime cause', async () => {
    const fake = fakeHost();
    const invalid = new IdentifierValidationError(
      'Invalid workspaceId: must be lowercase alphanumeric with hyphens',
    );
    const layout = new UnsupportedInstructionLayoutError(
      'AGENTS.md must be a regular file.',
    );
    const io = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    fake.read
      .mockRejectedValueOnce(invalid)
      .mockRejectedValueOnce(layout)
      .mockRejectedValueOnce(io);
    const active = createDesktopRuntime({
      workspaceInstructionsHost: fake.host,
    });
    runtime = active;
    const reader = caller({ grants: ['core.workspace.read'] });
    const get = (): Promise<unknown> =>
      rejection(
        active.query(
          'core.workspace.instructions.get',
          { workspaceId: 'ws-1' },
          { caller: reader },
        ),
      );
    const [first, second, third] = [await get(), await get(), await get()];
    expect(first).toBeInstanceOf(CanopyOperationError);
    expect(first).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.workspace.instructions.invalidWorkspaceId',
        message: invalid.message,
      },
      runtimeCause: invalid,
    });
    expect(second).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.instructions.unsupportedLayout',
        message: layout.message,
      },
      runtimeCause: layout,
    });
    expect(third).toMatchObject({
      payload: { kind: 'internal', message: 'The operation failed.' },
      runtimeCause: io,
    });
    // The IPC and Portal projection rethrows the host error itself.
    fake.read.mockRejectedValueOnce(io);
    await expect(getWorkspaceInstructions(active, reader, 'ws-1')).rejects.toBe(
      io,
    );
  });

  it('validates the workspace id with the legacy message before dispatch', async () => {
    const fake = fakeHost();
    runtime = createDesktopRuntime({ workspaceInstructionsHost: fake.host });
    for (const workspaceId of [42, undefined, 'Bad_Id']) {
      await expect(
        getWorkspaceInstructions(runtime, caller(), workspaceId),
      ).rejects.toThrow(
        'Invalid workspaceId: must be lowercase alphanumeric with hyphens',
      );
    }
    expect(fake.read).not.toHaveBeenCalled();
  });

  it('keys update telemetry by interface kind', () => {
    expect(
      workspaceInstructionsTelemetrySource({ interfaceKind: 'portal' }),
    ).toBe('portal');
    for (const interfaceKind of ['desktop', 'test', 'cli'] as const)
      expect(workspaceInstructionsTelemetrySource({ interfaceKind })).toBe(
        'claude_md',
      );
  });

  it('refuses an update after dispatcher shutdown', async () => {
    // Accepted change: once the dispatcher drains, a save racing app quit
    // fails as unavailable instead of writing.
    const fake = fakeHost();
    const stopped = createDesktopRuntime({
      workspaceInstructionsHost: fake.host,
    });
    await stopped.shutdown();
    await expect(
      updateWorkspaceInstructions(stopped, caller(), 'ws-1', '# Late'),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      getWorkspaceInstructions(stopped, caller(), 'ws-1'),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
  });
});
