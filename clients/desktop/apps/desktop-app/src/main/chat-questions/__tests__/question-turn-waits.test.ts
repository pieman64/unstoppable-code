import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import type { TurnEventSink } from '@canopy/core-runtime/node/agent/turns';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  beginChatTurnRun,
  emitChatTurnWait,
  type BeginChatTurnRunRequest,
} from '../../agent-runs/turn-runs';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
} from '../../chat-waits/desktop-chat-waits';
import {
  createPendingRequest,
  isPendingRequestOpen,
  rejectRequest,
  resolveRequest,
} from '../../mcp/pending-requests';
import { installApprovalTurnWaits } from '../../approvals/approval-turn-waits';
import { installQuestionTurnWaits } from '../question-turn-waits';

jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn(() => Promise.resolve({ outcome: 'interrupted' })),
  captureChatTurnStop: jest.fn(),
  captureChatTurnStopsForChat: jest.fn(() => []),
  adoptPreparingSendSession: jest.fn((context: unknown) => context),
  isChatTurnStopCurrent: jest.fn(() => true),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): object => ({ onTurnTerminal: jest.fn() }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    ingestProviderEvent: jest.fn(() => Promise.resolve()),
    getCompatibilityArchives: jest.fn(() => Promise.resolve({ archived: [] })),
  }),
}));

const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const questionScope = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const request: BeginChatTurnRunRequest = {
  scope,
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: 'model',
  initiationSource: 'user',
};
const ANSWERS: McpQuestionAnswer[] = [
  { question: 'Pick one', selectedOptions: ['A'] },
];

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
let seen: string[];
beforeEach(() => {
  resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
  root = mkdtempSync(join(tmpdir(), 'question-turn-waits-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  installQuestionTurnWaits(getDesktopChatWaits());
  seen = [];
  runtime.chatTurnRuns.observeWaits({
    opened: (_run, wait) => seen.push(`opened:${wait.waitId}:${wait.waitKind}`),
    resolved: (_run, wait) =>
      seen.push(`resolved:${wait.waitId}:${wait.resolution}`),
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

async function liveRun(): Promise<
  Awaited<ReturnType<typeof beginChatTurnRun>>
> {
  const run = await beginChatTurnRun(request);
  // The worker has taken the run once its first launch executes.
  await run.execute(() => undefined);
  return run;
}

async function parentStatus(): Promise<string | undefined> {
  const { items } = await operations.service.list({ limit: 20 });
  return items.find((item) => item.kind === 'core.chat.turn.run')?.status;
}

it('a question wait opens and resolves once on the live turn run', async () => {
  const run = await liveRun();
  const answers = createPendingRequest('q-1', 'session', {
    scope: questionScope,
  });
  await until(() => seen.length === 1);
  expect(seen).toEqual(['opened:q-1:question']);
  expect(await parentStatus()).toBe('running');

  expect(resolveRequest('q-1', ANSWERS)).toBe(true);
  await expect(answers).resolves.toEqual(ANSWERS);
  await until(() => seen.length === 2);
  expect(seen).toEqual(['opened:q-1:question', 'resolved:q-1:answered']);
  expect(await parentStatus()).toBe('running');
  run.settle('completed');
});

it('timeout, cancellation and failure resolve as expired, cancelled and cancelled', async () => {
  const run = await liveRun();
  const expired = createPendingRequest('q-expired', 'session', {
    scope: questionScope,
    timeoutMs: 5,
  });
  const cancelled = createPendingRequest('q-cancelled', 'session', {
    scope: questionScope,
  });
  const failed = createPendingRequest('q-failed', 'session', {
    scope: questionScope,
  });
  rejectRequest('q-cancelled', 'ask_user_cancelled');
  rejectRequest('q-failed', 'ask_user_persistence_failed');
  await Promise.allSettled([expired, cancelled, failed]);
  await until(() => seen.length === 6);
  expect(seen.filter((entry) => entry.startsWith('resolved:'))).toEqual(
    expect.arrayContaining([
      'resolved:q-expired:expired',
      'resolved:q-cancelled:cancelled',
      'resolved:q-failed:cancelled',
    ]),
  );
  run.settle('completed');
});

it('only question waits reach the turn seam', async () => {
  // The runtime also reports approval waits (CAN-4129); this covers the
  // question bridge alone.
  installApprovalTurnWaits(getDesktopChatWaits())();
  const run = await liveRun();
  const lifecycle = getDesktopChatWaits();
  lifecycle.open({
    waitId: 'approval-1',
    kind: 'approval',
    scope,
    sessionKey: 'session',
  });
  lifecycle.cancel('approval-1', { reason: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen).toEqual([]);
  run.settle('completed');
});

it('with no live turn run the question still waits', async () => {
  expect(
    emitChatTurnWait(scope, {
      kind: 'wait_opened',
      waitId: 'q-idle',
      waitKind: 'question',
    }),
  ).toBe(false);
  const answers = createPendingRequest('q-idle', 'session', {
    scope: questionScope,
  });
  expect(isPendingRequestOpen('q-idle')).toBe(true);
  expect(resolveRequest('q-idle', ANSWERS)).toBe(true);
  await expect(answers).resolves.toEqual(ANSWERS);
  expect(seen).toEqual([]);
});

it("wait envelopes keep the run's sequence", async () => {
  const sequences: number[] = [];
  const sinkFor = runtime.chatTurnRuns.sinkFor.bind(runtime.chatTurnRuns);
  jest.spyOn(runtime.chatTurnRuns, 'sinkFor').mockImplementation((id) => {
    const sink = sinkFor(id);
    if (!sink) return null;
    const observed: TurnEventSink = (event, local) => {
      sequences.push(event.sequence);
      return sink(event, local);
    };
    return observed;
  });
  const run = await beginChatTurnRun(request);
  const onEvent = run.observe(() => undefined);
  await run.execute(async () => {
    await onEvent({ type: 'event', index: 0 });
    const answers = createPendingRequest('q-order', 'session', {
      scope: questionScope,
    });
    await onEvent({ type: 'event', index: 1 });
    resolveRequest('q-order', ANSWERS);
    await answers;
  });
  await until(() => seen.length === 2);
  expect(sequences).toEqual([0, 1, 2, 3]);
  expect(seen).toEqual([
    'opened:q-order:question',
    'resolved:q-order:answered',
  ]);
  run.settle('completed');
});
