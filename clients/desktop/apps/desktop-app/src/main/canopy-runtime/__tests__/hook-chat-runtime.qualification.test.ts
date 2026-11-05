import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

it('serves a headless hook claim through core.operation.get, core.operation.list and core.operation.events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-chat-runtime-qualification-'));
  const adapter = createCoreOperationAdapter({
    ledgerPath: (): string => join(dir, 'operations.sqlite'),
  });
  const runtime = createDesktopRuntime({
    operationAdapter: adapter,
    shutdownTimeoutMs: 25,
  });
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'observer',
    authorityId: 'desktop-local',
    interfaceKind: 'desktop',
    grants: ['core.operation.read'],
  };
  try {
    const run = await adapter.service.admit({
      kind: 'core.initiatedWork.run',
      status: 'running',
      origin: { kind: 'hook', sourceId: 'project:pr:create' },
      owner: { kind: 'principal', id: 'local-desktop-user' },
      scope: { workspaceId: 'p', worktreeId: 'w' },
    });
    const request = {
      runOperationId: run.operation.operationId,
      chatId: 'chat-hook-op-1-0',
      userMessageId: 'msg-hook-op-1-0',
      scope: { workspaceId: 'p', worktreeId: 'w' },
    };
    const claim = await runtime.hookChatClaims.claim(request);
    const listed = await runtime.query('core.operation.list', {}, { caller });
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: claim.claimOperationId,
          kind: 'core.initiatedWork.hookChat',
          scope: { ...request.scope, chatId: request.chatId },
        }),
      ]),
    );
    const watching = await runtime.openStream(
      'core.operation.events',
      { operationIds: [claim.claimOperationId], cursor: listed.eventsCursor },
      { caller },
    );
    const events: string[] = [];
    watching.onFrame((frame) => {
      if (frame.kind === 'item')
        events.push(`${frame.item.event}:${frame.item.operation.status}`);
    });
    try {
      await runtime.hookChatClaims.recordAccepted(
        claim.claimOperationId,
        request,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual(['completed:completed']);
      await expect(
        runtime.query(
          'core.operation.get',
          { operationId: claim.claimOperationId },
          { caller },
        ),
      ).resolves.toMatchObject({
        operation: {
          status: 'completed',
          outcome: {
            chatId: request.chatId,
            userMessageId: request.userMessageId,
            accepted: true,
          },
        },
      });
    } finally {
      watching.close();
    }
  } finally {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
