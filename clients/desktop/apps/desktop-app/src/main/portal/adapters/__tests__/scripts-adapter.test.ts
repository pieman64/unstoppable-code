import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  handlePortalScriptCancel,
  handlePortalScriptLogRequest,
  handlePortalScriptRun,
} from '../scripts-adapter';
import type { PortalAdapterContext } from '../types';
import {
  cancelScript,
  readAndEmitScriptRunTail,
  runScript,
} from '../../../services/scripts-service';
import { sendToWindow } from '../../../lib/window-send';
import { logMainProcessError } from '../../../lib/main-process-logging';
import { PortalServiceError } from '../../../services/portal-service-error';

jest.mock('../../../services/scripts-service', () => ({
  cancelScript: jest.fn(),
  getScriptSourceInfo: jest.fn(),
  readAndEmitScriptRunTail: jest.fn(),
  runScript: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

const mockedRunScript = jest.mocked(runScript);
const mockedCancelScript = jest.mocked(cancelScript);
const mockedReadAndEmitScriptRunTail = jest.mocked(readAndEmitScriptRunTail);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedLogMainProcessError = jest.mocked(logMainProcessError);

function command(
  type: PortalCommandEnvelope['type'],
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: 'cmd-1',
    sequence: 7,
    type,
    payload,
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
  } as PortalCommandEnvelope;
}

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    enqueueEvent: (event) => events.push(event),
    complete: (cmd, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: cmd.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (cmd, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: cmd.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

describe('scripts portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes immediately while the script remains active', async () => {
    const events: PortalEventEnvelope[] = [];
    const activeRun = new Promise<never>(() => undefined);
    mockedRunScript.mockImplementation((_request, options) => {
      options.onExecutionStarted?.();
      return activeRun;
    });

    await handlePortalScriptRun(
      command('portal.script.run', {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptName: 'test',
      }) as Parameters<typeof handlePortalScriptRun>[0],
      adapterContext(events),
    );

    expect(mockedRunScript).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ portalCommandId: 'cmd-1' }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(events[0]).toMatchObject({ payload: { result: { ok: true } } });
  });

  it('allows cancel to complete while a run is still active', async () => {
    const events: PortalEventEnvelope[] = [];
    let registered = false;
    mockedRunScript.mockImplementation((_request, options) => {
      registered = true;
      options.onExecutionStarted?.();
      return new Promise<never>(() => undefined);
    });
    mockedCancelScript.mockImplementation(() => {
      if (!registered) {
        throw new Error('run was not registered');
      }
      return Promise.resolve({ ok: true });
    });
    const context = adapterContext(events);

    await handlePortalScriptRun(
      command('portal.script.run', {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptName: 'test',
      }) as Parameters<typeof handlePortalScriptRun>[0],
      context,
    );
    await handlePortalScriptCancel(
      command('portal.script.cancel', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:test',
      }) as Parameters<typeof handlePortalScriptCancel>[0],
      context,
    );

    expect(mockedCancelScript).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
      'portal.command.completed',
    ]);
  });

  it('fails the command when script validation rejects before start', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRunScript.mockRejectedValue(
      new PortalServiceError('invalid_payload', 'scriptName is required.'),
    );

    await handlePortalScriptRun(
      command('portal.script.run', {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptName: '',
      }) as Parameters<typeof handlePortalScriptRun>[0],
      adapterContext(events),
    );

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        error: {
          code: 'invalid_payload',
          message: 'scriptName is required.',
        },
      },
    });
  });

  it('mirrors portal run lifecycle events to the renderer window', async () => {
    const events: PortalEventEnvelope[] = [];
    const window = { marker: 'window' };
    mockedRunScript.mockImplementation((_request, options) => {
      options.onExecutionStarted?.();
      options.onRendererStarted?.({ marker: 'started' } as never);
      options.onRendererOutput?.({ marker: 'output' } as never);
      options.onRendererComplete?.({ marker: 'complete' } as never);
      return Promise.resolve({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 1,
      });
    });

    await handlePortalScriptRun(
      command('portal.script.run', {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptName: 'test',
      }) as Parameters<typeof handlePortalScriptRun>[0],
      { ...adapterContext(events), getWindow: () => window as never },
    );

    expect(mockedSendToWindow.mock.calls.map((call) => call.slice(1))).toEqual([
      ['script:started', { marker: 'started' }],
      ['script:output', { marker: 'output' }],
      ['script:complete', { marker: 'complete' }],
    ]);
  });

  it('does not throw when no renderer window exists', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRunScript.mockImplementation((_request, options) => {
      options.onExecutionStarted?.();
      options.onRendererStarted?.({ marker: 'started' } as never);
      return new Promise<never>(() => undefined);
    });

    await expect(
      handlePortalScriptRun(
        command('portal.script.run', {
          target: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          scriptName: 'test',
        }) as Parameters<typeof handlePortalScriptRun>[0],
        { ...adapterContext(events), getWindow: () => null },
      ),
    ).resolves.toBeUndefined();

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      'script:started',
      expect.any(Object),
    );
  });

  it('does not let an unavailable renderer throw into command handling', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedSendToWindow.mockImplementationOnce(() => {
      throw new Error('Render frame was disposed');
    });
    mockedRunScript.mockImplementation((_request, options) => {
      options.onExecutionStarted?.();
      options.onRendererStarted?.({ marker: 'started' } as never);
      return new Promise<never>(() => undefined);
    });

    await expect(
      handlePortalScriptRun(
        command('portal.script.run', {
          target: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          scriptName: 'test',
        }) as Parameters<typeof handlePortalScriptRun>[0],
        {
          ...adapterContext(events),
          getWindow: () => ({ marker: 'destroyed-window' }) as never,
        },
      ),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('portal.command.completed');
  });

  it('logs a detached execution rejection after acknowledging start', async () => {
    const events: PortalEventEnvelope[] = [];
    const failure = new Error('process failed after start');
    mockedRunScript.mockImplementation((_request, options) => {
      options.onExecutionStarted?.();
      return Promise.reject(failure);
    });

    await handlePortalScriptRun(
      command('portal.script.run', {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptName: 'test',
      }) as Parameters<typeof handlePortalScriptRun>[0],
      adapterContext(events),
    );
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(mockedLogMainProcessError).toHaveBeenCalledWith(
      'Portal script execution failed after it started.',
      failure,
    );
  });

  it('log_request emits a script_run upsert before completing with lines', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedReadAndEmitScriptRunTail.mockResolvedValue({
      lines: ['one', 'two'],
      run: {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        localId: 'run-1',
        scriptId: 'script-1',
        // Transport plan §1.2 canonical fields.
        scriptKey: 'script-1',
        scriptName: 'test',
        name: 'Test',
        target: 'project',
        status: 'running',
        outputTail: 'one\ntwo',
      },
    });

    await handlePortalScriptLogRequest(
      command('portal.script.log_request', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptKey: 'script-1',
      }) as Parameters<typeof handlePortalScriptLogRequest>[0],
      adapterContext(events),
    );

    expect(mockedReadAndEmitScriptRunTail).toHaveBeenCalledWith(
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptKey: 'script-1',
      },
      { portalCommandId: 'cmd-1' },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(events[0]).toMatchObject({
      payload: { result: { lines: ['one', 'two'] } },
    });
  });
});
