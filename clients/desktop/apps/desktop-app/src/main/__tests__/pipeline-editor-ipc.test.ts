jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));

import {
  IPC_CHANNELS,
  type PipelineEditorRendererToolResponse,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  registerPipelineEditorHandlers,
  requestPipelineEditorRendererTool,
  type PipelineEditorRendererToolSurfaces,
} from '../ipc/pipeline-editor';
import { sendToWindowDetailed } from '../lib/window-send';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);

type RegisteredIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function isRegisteredIpcHandler(value: unknown): value is RegisteredIpcHandler {
  return typeof value === 'function';
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Expected handler for ${channel}`);
  }
  const handler: unknown = call[1];
  if (!isRegisteredIpcHandler(handler)) {
    throw new Error(`Expected registered handler for ${channel}`);
  }
  return handler;
}

function respond(response: PipelineEditorRendererToolResponse): void {
  getHandler(IPC_CHANNELS.pipelineEditorToolResponse)(undefined, response);
}

function makeSurfaces(): PipelineEditorRendererToolSurfaces {
  return {
    getMainWindow: () => null,
  };
}

describe('Pipeline Editor IPC tool routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerPipelineEditorHandlers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes renderer tool requests to the main window', async () => {
    const promise = requestPipelineEditorRendererTool(
      { kind: 'list', requestId: 'list-request' },
      makeSurfaces(),
    );

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.pipelineEditorToolRequest,
      expect.objectContaining({ kind: 'list' }),
    );

    respond({
      requestId: 'list-request',
      ok: true,
      pipelines: [],
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('accepts provider-owned renderer response request IDs', async () => {
    const promise = requestPipelineEditorRendererTool(
      { kind: 'list', requestId: 'codex_call_123' },
      makeSurfaces(),
    );

    respond({
      requestId: 'codex_call_123',
      ok: true,
      pipelines: [],
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('rejects malformed renderer responses', () => {
    expect(() => {
      getHandler(IPC_CHANNELS.pipelineEditorToolResponse)(undefined, {
        requestId: '',
        ok: true,
      });
    }).toThrow(/Invalid pipeline editor renderer tool response/i);
  });

  it('settles deduplicated waiters when a renderer tool request times out', async () => {
    jest.useFakeTimers();
    const first = requestPipelineEditorRendererTool(
      { kind: 'list', requestId: 'timeout-request' },
      makeSurfaces(),
    );
    const second = requestPipelineEditorRendererTool(
      { kind: 'list', requestId: 'timeout-request' },
      makeSurfaces(),
    );

    jest.advanceTimersByTime(30_000);

    await expect(first).resolves.toMatchObject({
      requestId: 'timeout-request',
      ok: false,
    });
    await expect(second).resolves.toMatchObject({
      requestId: 'timeout-request',
      ok: false,
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(1);
  });

  it('scopes pending and completed requests to the originating chat (CAN-3976)', async () => {
    const first = requestPipelineEditorRendererTool(
      { kind: 'set_yaml', requestId: '1', originChatId: 'a', yaml: 'a: 1' },
      makeSurfaces(),
    );
    const second = requestPipelineEditorRendererTool(
      { kind: 'set_yaml', requestId: '1', originChatId: 'b', yaml: 'b: 1' },
      makeSurfaces(),
    );
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(2);

    respond({ requestId: '1', originChatId: 'b', ok: true, pipelineYaml: 'b' });
    respond({ requestId: '1', ok: true, pipelineYaml: 'none' });
    respond({ requestId: '1', originChatId: 'a', ok: true, pipelineYaml: 'a' });
    await expect(first).resolves.toMatchObject({ pipelineYaml: 'a' });
    await expect(second).resolves.toMatchObject({ pipelineYaml: 'b' });

    await expect(
      requestPipelineEditorRendererTool(
        { kind: 'set_yaml', requestId: '1', originChatId: 'a', yaml: 'a: 1' },
        makeSurfaces(),
      ),
    ).resolves.toMatchObject({ pipelineYaml: 'a' });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(2);
  });
});
