/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no SubtleCrypto; the dispatcher's pipeline helpers need one at import.
import { webcrypto } from 'node:crypto';

class TestTextEncoder {
  encode(value: string): Uint8Array {
    return Uint8Array.from(
      Array.from(value, (char: string) => char.charCodeAt(0)),
    );
  }
}
Object.assign(globalThis, { TextEncoder: TestTextEncoder });
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
});

import {
  dispatchAppAction,
  __resetAppActionDispatcherForTests,
} from '@/lib/app-actions/dispatcher';
import {
  openPipelineExecutionPanel as openPipelineExecutionPanelImpl,
  PIPELINE_RUN_OPEN_ERROR_MESSAGES,
  type OpenPipelineExecutionErrorCode,
} from '@/lib/panels/open-pipeline-execution';
import type * as OpenerModule from '@/lib/panels/open-pipeline-execution';

jest.mock('@/lib/panels/open-pipeline-execution', () => {
  const actual = jest.requireActual<typeof OpenerModule>(
    '@/lib/panels/open-pipeline-execution',
  );
  return {
    ...actual,
    openPipelineExecutionPanel: jest.fn(),
  };
});

const openPipelineExecutionPanel = jest.mocked(openPipelineExecutionPanelImpl);

let requestCounter = 0;

function dispatch(
  action: Record<string, unknown>,
): ReturnType<typeof dispatchAppAction> {
  requestCounter += 1;
  return dispatchAppAction({
    requestId: `req-open-run-${requestCounter}`,
    source: 'assistant',
    // The dispatcher validates the raw payload; malformed payloads are the
    // point of some cases below.
    action,
  });
}

describe('pipeline.open_run', () => {
  beforeEach(() => {
    __resetAppActionDispatcherForTests();
    openPipelineExecutionPanel.mockReset();
  });

  it('awaits the opener and succeeds only once the run panel is shown', async () => {
    let settle: (() => void) | null = null;
    openPipelineExecutionPanel.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = (): void =>
            resolve({
              status: 'applied',
              ownerKey: 'project-1/worktree-1',
              layoutKey: 'project-1/worktree-1',
              panelId: 'panel-pipeline-run-1',
              outcome: 'placed',
            });
        }),
    );

    const pending = dispatch({
      type: 'pipeline.open_run',
      executionId: 'run-1',
      jobId: 'deploy',
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'run-1',
      target: { jobId: 'deploy' },
    });

    settle?.();
    const response = await pending;

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      host: 'panel',
      outcome: 'placed',
      ownerKey: 'project-1/worktree-1',
      panelId: 'panel-pipeline-run-1',
      auxiliaryWindow: false,
    });
  });

  it('passes an owner hint (the main-window artifact handoff) to the opener', async () => {
    openPipelineExecutionPanel.mockResolvedValue({
      status: 'applied',
      ownerKey: 'cowork-1/entry-1',
      layoutKey: 'cowork-1/entry-1#aux:runs',
      panelId: 'panel-pipeline-run-1',
      outcome: 'revealed',
    });

    const response = await dispatch({
      type: 'pipeline.open_run',
      executionId: 'run-1',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
    });

    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'run-1',
      owner: { projectId: 'cowork-1', worktreeId: 'entry-1' },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { host: 'panel', outcome: 'revealed', auxiliaryWindow: true },
    });
  });

  it('reports an ownerless run shown in the compatibility view as success', async () => {
    openPipelineExecutionPanel.mockResolvedValue({
      status: 'ownerless',
      executionId: 'run-1',
      reason: 'no-owner',
    });

    await expect(
      dispatch({ type: 'pipeline.open_run', executionId: 'run-1' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { host: 'compatibility', reason: 'no-owner' },
    });
  });

  it.each<[OpenPipelineExecutionErrorCode, string, boolean | undefined]>([
    ['not_found', 'not_found', undefined],
    ['owner_missing', 'not_found', undefined],
    ['owner_mismatch', 'invalid_target', undefined],
    ['navigation_failed', 'navigation_failed', true],
    ['superseded', 'navigation_failed', undefined],
    ['layout_unavailable', 'surface_unavailable', true],
  ])(
    'returns the structured %s error as %s',
    async (code, expectedCode, retryable) => {
      openPipelineExecutionPanel.mockResolvedValue({
        status: 'error',
        code,
        message: PIPELINE_RUN_OPEN_ERROR_MESSAGES[code],
      });

      const response = await dispatch({
        type: 'pipeline.open_run',
        executionId: 'run-1',
      });

      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: expectedCode,
        message: PIPELINE_RUN_OPEN_ERROR_MESSAGES[code],
        ...(retryable !== undefined ? { retryable } : {}),
      });
    },
  );

  it('rejects a half owner hint or a non-string job before opening', async () => {
    for (const action of [
      { type: 'pipeline.open_run', executionId: 'run-1', projectId: 'p' },
      { type: 'pipeline.open_run', executionId: 'run-1', worktreeId: 'w' },
      { type: 'pipeline.open_run', executionId: 'run-1', jobId: 7 },
      { type: 'pipeline.open_run' },
    ]) {
      const response = await dispatch(action);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
    }
    expect(openPipelineExecutionPanel).not.toHaveBeenCalled();
  });
});
