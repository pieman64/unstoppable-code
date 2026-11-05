import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_INITIATED_WORK_RUN_KIND } from '@canopy/protocol/canopy-core';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import { InitiatedWorkEngine } from '../engine';
import { HookChatClaims, type HookChatClaimRequest } from '../hook-chat-claims';

let dir: string;
let now: number;
let operations: OperationService;
let claims: HookChatClaims;
let request: HookChatClaimRequest;

function open(): void {
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operations.sqlite'), {
        clock: (): number => now,
        retryWindowMs: 1_000,
      }),
    clock: (): number => now,
  });
  new InitiatedWorkEngine({ operations });
  claims = new HookChatClaims({ operations });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-chat-claims-'));
  now = Date.parse('2026-11-04T12:00:00Z');
  open();
  const run = await operations.admit({
    kind: CORE_INITIATED_WORK_RUN_KIND,
    status: 'running',
    origin: {
      kind: 'hook',
      sourceId: 'project:pr:create',
      occurrenceKey: 'occ-1',
    },
    owner: { kind: 'principal', id: 'local' },
    scope: { workspaceId: 'p', worktreeId: 'w' },
  });
  request = {
    runOperationId: run.operation.operationId,
    chatId: 'chat-hook-op-1-0',
    userMessageId: 'msg-hook-op-1-0',
    scope: { workspaceId: 'p', worktreeId: 'w' },
  };
});
afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

it('claims a hook chat action once', async () => {
  const first = await claims.claim(request);
  expect(first.status).toBe('claimed');
  expect(await claims.claim(request)).toEqual({
    status: 'already_claimed',
    claimOperationId: first.claimOperationId,
    state: 'pending',
  });
  await claims.recordAccepted(first.claimOperationId, request);
  expect(await claims.claim(request)).toEqual({
    status: 'already_claimed',
    claimOperationId: first.claimOperationId,
    state: 'accepted',
  });
  expect(await operations.get(first.claimOperationId)).toMatchObject({
    kind: 'core.initiatedWork.hookChat',
    scope: { workspaceId: 'p', worktreeId: 'w', chatId: request.chatId },
    parentOperationId: null,
    origin: { kind: 'hook', sourceId: 'project:pr:create' },
    owner: { kind: 'principal', id: 'local' },
  });
  expect(
    (await operations.get(first.claimOperationId))?.origin.occurrenceKey,
  ).toBeUndefined();
});
it('records a claim that did not lead to an accepted turn', async () => {
  const first = await claims.claim(request);
  await claims.recordNotAccepted(first.claimOperationId, request, 'returned');
  expect(await claims.claim(request)).toMatchObject({ state: 'not_accepted' });
  const other = {
    ...request,
    chatId: 'chat-hook-op-1-1',
    userMessageId: 'msg-hook-op-1-1',
  };
  const second = await claims.claim(other);
  await claims.recordFailed(second.claimOperationId, 'provider down');
  expect(await claims.claim(other)).toMatchObject({ state: 'not_accepted' });
  expect((await operations.get(second.claimOperationId))?.error?.code).toBe(
    'core.initiatedWork.hookChat.failed',
  );
});
it('keeps answering a claim after a restart interrupted it', async () => {
  const first = await claims.claim(request);
  operations.close();
  open();
  expect(await claims.claim(request)).toMatchObject({
    status: 'already_claimed',
    state: 'interrupted',
  });
  expect(await operations.get(first.claimOperationId)).toMatchObject({
    status: 'failed',
    error: { code: 'core.operation.interrupted' },
  });
});
it('keeps answering a claim after its outcome expired', async () => {
  const first = await claims.claim(request);
  await claims.recordAccepted(first.claimOperationId, request);
  now += 1_001;
  (await operations.ready()).compact();
  expect(await claims.claim(request)).toEqual({
    status: 'already_claimed',
    claimOperationId: first.claimOperationId,
    state: 'expired',
  });
});
it('refuses to cancel a claim', async () => {
  const first = await claims.claim(request);
  await expect(
    operations.cancel(first.claimOperationId, {
      requestedBy: 'portal-client',
      reason: 'stop',
    }),
  ).rejects.toThrow('Stop the hook chat from the chat itself.');
  expect((await operations.get(first.claimOperationId))?.status).toBe(
    'running',
  );
});

it('looks up claims without admitting new work and refuses identity key reuse', async () => {
  expect(await claims.lookup(request)).toBeNull();
  expect(
    (
      await operations.list({
        kinds: ['core.initiatedWork.hookChat'],
        limit: 50,
      })
    ).items,
  ).toHaveLength(0);
  const first = await claims.claim(request);
  expect(await claims.lookup(request)).toEqual({
    status: 'already_claimed',
    claimOperationId: first.claimOperationId,
    state: 'pending',
  });
  await claims.recordAccepted(first.claimOperationId, request);
  expect(await claims.lookup(request)).toMatchObject({ state: 'accepted' });
  now += 1_001;
  (await operations.ready()).compact();
  expect(await claims.lookup(request)).toMatchObject({ state: 'expired' });
  await expect(
    claims.lookup({ ...request, userMessageId: 'other-message' }),
  ).rejects.toMatchObject({ refusal: 'key-reused' });
});
