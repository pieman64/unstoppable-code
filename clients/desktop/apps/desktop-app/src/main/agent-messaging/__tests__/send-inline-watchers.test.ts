import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentSendAcceptanceFacts,
  InlineChatWatcherReservationInput,
  InlineChatWatcherReservationPort,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type { CanonicalChatTerminalEvent } from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import { readCanonicalWatcherStore } from '../../app-advisor/chat-watcher-storage';

let mockDirectory: string;
jest.mock('../../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string =>
    join(mockDirectory, 'app-advisor-watchers.json'),
  getDataDir: (): string => mockDirectory,
}));
jest.mock('../../agents/session-manager', () => ({}));
jest.mock('../../pipelines/pipeline-service', () => ({}));
jest.mock('../../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../../lib/app-advisor-project-agent-access', () => ({}));
jest.mock('../../lib/github-workflow-run-observer', () => ({
  getGitHubWorkflowRunObserver: (): object => ({ stop: (): void => undefined }),
}));
jest.mock('../../lib/github-pull-request-observer', () => ({
  getGitHubPullRequestObserver: (): object => ({ stop: (): void => undefined }),
}));
jest.mock('../../lib/github-pr-read-model', () => ({}));
jest.mock('../../lib/github-broker', () => ({}));
jest.mock('../../lib/github-broker/workflow-definitions', () => ({}));
jest.mock('../../lib/github-broker/workflow-runs', () => ({}));
jest.mock('../../lib/cowork-work-entries', () => ({}));
jest.mock('../../lib/workspace-persistence', () => ({}));
jest.mock('../../app-advisor/chat-watcher-access', () => ({
  resolveChatWatcherTarget: (entry: { target: object }): Promise<object> =>
    Promise.resolve(
      'botId' in entry.target
        ? { kind: 'bot', address: entry.target }
        : { kind: 'project', projectType: 'code', address: entry.target },
    ),
  decideChatWatcherAccess: (): Promise<object> =>
    Promise.resolve({
      allowed: true,
      sourceOwner: { kind: 'personal' },
      resourceIncarnation: 'stable',
    }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    hasTranscriptMessage: (): Promise<boolean> => Promise.resolve(false),
  }),
}));
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';

// This acceptance seam deliberately avoids depending on slice A's provider orchestration.
describe('send inline watcher port with the real durable watcher service', () => {
  const target = {
    projectId: 'project',
    taskId: 'target-task',
    chatId: 'target-chat',
  };
  const request = (): InlineChatWatcherReservationInput => ({
    destination: {
      projectId: 'project',
      worktreeId: 'origin-task',
      chatId: 'origin-root',
    },
    recipient: { kind: 'root' },
    target,
    entries: [{}],
    acceptedInputId: 'send-input',
    commandId: 'send-command',
    createdByToolUseId: 'send-tool',
  });
  const accepted = (): AgentSendAcceptanceFacts => ({
    acceptedInputId: 'send-input',
    disposition: 'queued',
    queuedMessageId: 'real-host-queue-id',
    acceptedAt: new Date().toISOString(),
  });
  const terminal = (): CanonicalChatTerminalEvent => ({
    kind: 'terminal',
    address: target,
    eventId: 'send-terminal',
    sourceInputId: 'send-input',
    sourceInputAcceptedAt: new Date().toISOString(),
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    disposition: 'completed',
    evidence: { sourceOwner: { kind: 'personal' } },
  });
  beforeEach(async () => {
    mockDirectory = await mkdtemp(join(tmpdir(), 'send-inline-'));
  });
  afterEach(async () => {
    getAppAdvisorWatcherService().shutdown();
    await rm(mockDirectory, { recursive: true, force: true });
  });
  async function rows(): Promise<unknown[]> {
    return readCanonicalWatcherStore(
      join(mockDirectory, 'app-advisor-watchers-canonical.json'),
    );
  }
  it('reserves before fake dispatch, defers instant completion and confirms one durable outbox', async () => {
    const service = getAppAdvisorWatcherService();
    const port: InlineChatWatcherReservationPort = service;
    const reservation = await port.reserveInlineChatWatchers(request());
    if (!reservation.ok) throw new Error(reservation.error);
    const dispatch = jest.fn(async (): Promise<AgentSendAcceptanceFacts> => {
      expect(await rows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'inline_chat_pending_watcher' }),
        ]),
      );
      await service.handleCanonicalChatTerminalEvent(terminal());
      expect(JSON.stringify(await rows())).not.toContain(
        'pendingLocalDelivery',
      );
      return accepted();
    });
    const acceptance = await dispatch();
    await port.confirmInlineChatWatchers(
      reservation.reservation.reservationId,
      acceptance,
    );
    await service.whenChatDeliveriesSettled();
    const firstOutbox = await rows();
    const deliveryId: unknown = expect.any(String);
    const pendingLocalDelivery: unknown = expect.objectContaining({
      deliveryId,
    });
    expect(firstOutbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reservation.reservation.receipts[0]?.watcherId,
          status: 'firing',
          createdByToolUseId: 'send-tool',
          destination: request().destination,
          pendingLocalDelivery,
        }),
      ]),
    );
    await port.confirmInlineChatWatchers(
      reservation.reservation.reservationId,
      acceptance,
    );
    await service.handleCanonicalChatTerminalEvent(terminal());
    await service.whenChatDeliveriesSettled();
    expect(await rows()).toEqual(firstOutbox);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      await readFile(join(mockDirectory, 'app-advisor-watchers.json'), 'utf8'),
    ).not.toContain('send-input');
  });
  it('a definitely failed dispatch cancels its rows before any terminal can deliver', async () => {
    const service = getAppAdvisorWatcherService();
    const port: InlineChatWatcherReservationPort = service;
    const reservation = await port.reserveInlineChatWatchers(request());
    if (!reservation.ok) throw new Error(reservation.error);
    const dispatch = jest
      .fn<Promise<AgentSendAcceptanceFacts>, []>()
      .mockRejectedValue(new Error('not accepted'));
    await expect(dispatch()).rejects.toThrow('not accepted');
    await port.cancelInlineChatWatchers(reservation.reservation.reservationId);
    await service.handleCanonicalChatTerminalEvent(terminal());
    expect(await rows()).toEqual([]);
    expect(await service.list()).toEqual([]);
  });
  it('batch refusal prevents dispatch and creates no partial reservation', async () => {
    const dispatch = jest.fn();
    const port: InlineChatWatcherReservationPort =
      getAppAdvisorWatcherService();
    const result = await port.reserveInlineChatWatchers({
      ...request(),
      entries: [{}, { followUpInstruction: 'x'.repeat(8001) }],
    });
    if (result.ok) dispatch();
    expect(result).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});
