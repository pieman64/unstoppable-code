import type { PipelineExecutionActions } from '../usePipelineExecutionActions';

/**
 * A controller double for detail and modal tests: every command is a jest
 * mock and nothing is in flight unless overridden.
 */
export function createFakePipelineExecutionActions(
  overrides: Partial<PipelineExecutionActions> = {},
): PipelineExecutionActions {
  return {
    cancellingId: null,
    resumingId: null,
    retryingIds: new Set<string>(),
    rerunningIds: new Set<string>(),
    debuggingFailureId: null,
    chatFollowUpInProgress: false,
    cancel: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    resume: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    retry: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    rerun: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    debugFailure: jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    ),
    chatFollowUp: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    reportChatFollowUp: jest.fn<Promise<void>, [string]>(() =>
      Promise.resolve(),
    ),
    pipelineFollowUp: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    openReport: jest.fn<void, [string]>(),
    openPlan: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    dialogs: <span data-testid="fake-pipeline-action-dialogs" />,
    dialogAnchorRef: jest.fn<void, [HTMLElement | null]>(),
    ...overrides,
  };
}
