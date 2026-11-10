import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';

const mockSteps: string[] = [];
const mockCommitTurnPause = jest.fn(
  (input: { type: string; ownerKind: string; ownerId: string }) => {
    mockSteps.push(`${input.type}:${input.ownerKind}`);
    return Promise.resolve();
  },
);
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    commitTurnPause: mockCommitTurnPause,
  }),
}));
const mockAuditPause = jest.fn(() => {
  mockSteps.push('audit:pause');
});
const mockAuditResume = jest.fn(() => {
  mockSteps.push('audit:resume');
});
jest.mock('../../observability/ingest', () => ({
  getExecutionObservabilityIngest: (): object => ({
    pauseChatTurn: mockAuditPause,
    resumeChatTurn: mockAuditResume,
    recordSessionDiagnostic: (): undefined => undefined,
  }),
}));
jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: jest.fn(),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorRendererToolResponse,
  type McpQuestion,
} from '@canopy/desktop-shared/types';
import { requestAppAdvisorRendererTool } from '../../ipc/app-advisor';
import {
  createAppAdvisorToolRuntime,
  type AppAdvisorToolRuntimeSurfaces,
} from '../runtime';

const windowRequest = jest.mocked(requestAppAdvisorRendererTool);
const destination = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: APP_ADVISOR_WORKTREE_ID,
  chatId: 'advisor-chat',
};
const surfaces: AppAdvisorToolRuntimeSurfaces = {
  getMainWindow: (): null => null,
  getAppAdvisorWindow: (): null => null,
  openAppAdvisorWindow: () => Promise.resolve({ open: false, focused: false }),
  ensureAppAdvisorWindow: () =>
    Promise.resolve({ open: false, focused: false }),
};
const question: McpQuestion = {
  question: 'Which project?',
  header: 'Project',
  options: ['Canopy'],
  multiSelect: false,
};

function answering(
  response: (requestId: string) => AppAdvisorRendererToolResponse,
): void {
  windowRequest.mockImplementation((request) => {
    mockSteps.push('asked');
    return Promise.resolve(response(request.requestId));
  });
}

beforeEach(() => {
  mockSteps.length = 0;
  mockCommitTurnPause.mockClear();
  mockAuditPause.mockClear();
  mockAuditResume.mockClear();
  windowRequest.mockReset();
});

describe('App Advisor question waits pause the canonical turn (CAN-5827)', () => {
  it('an App Advisor question pauses the canonical turn until it settles', async () => {
    answering((requestId) => ({
      requestId,
      ok: true,
      answer: {
        questionId: 'q1',
        question: 'Which project?',
        selectedOptions: ['Canopy'],
      },
    }));
    const runtime = createAppAdvisorToolRuntime(surfaces, destination);
    await expect(runtime.requestUserAnswers([question])).resolves.toHaveLength(
      1,
    );
    // The audit keeps its own tally too, as worktree chats do, for the
    // shared fallback when the canonical record is late or never matches.
    expect(mockSteps).toEqual([
      'PauseOpened:question',
      'audit:pause',
      'asked',
      'audit:resume',
      'PauseClosed:question',
    ]);
    const [opened, closed] = mockCommitTurnPause.mock.calls.map(
      ([input]) => input,
    );
    expect(opened).toMatchObject({
      ...destination,
      ownerKind: 'question',
    });
    expect(closed?.ownerId).toBe(opened?.ownerId);
    expect(mockAuditPause).toHaveBeenCalledWith(
      destination.projectId,
      destination.worktreeId,
      destination.chatId,
    );
  });

  it('a dismissed question still closes its pause', async () => {
    answering((requestId) => ({
      requestId,
      ok: false,
      error: { code: 'execution_failed', message: 'User dismissed' },
    }));
    const runtime = createAppAdvisorToolRuntime(surfaces, destination);
    await expect(runtime.requestUserAnswers([question])).rejects.toThrow(
      'User dismissed',
    );
    expect(mockSteps).toEqual([
      'PauseOpened:question',
      'audit:pause',
      'asked',
      'audit:resume',
      'PauseClosed:question',
    ]);
  });

  it('a question whose pause cannot be committed is not asked and closes its pause', async () => {
    mockCommitTurnPause.mockImplementationOnce(() =>
      Promise.reject(new Error('Canonical turn pause could not be committed')),
    );
    const runtime = createAppAdvisorToolRuntime(surfaces, destination);
    await expect(runtime.requestUserAnswers([question])).rejects.toThrow(
      'ask_user_persistence_failed',
    );
    expect(windowRequest).not.toHaveBeenCalled();
    // The reducer saw the pause open before its commit failed, so the turn
    // must not stay paused for a question that was never shown.
    const calls = mockCommitTurnPause.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.type)).toEqual([
      'PauseOpened',
      'PauseClosed',
    ]);
    expect(calls[1]?.ownerId).toBe(calls[0]?.ownerId);
    expect(mockAuditPause).not.toHaveBeenCalled();
    expect(mockAuditResume).not.toHaveBeenCalled();
  });
});
