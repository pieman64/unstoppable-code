/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AppAdvisorRendererToolRequest,
  AppAdvisorRendererToolResponse,
} from '@canopy/desktop-shared/types';

const mockDispatchAppAction = jest.fn(
  (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
);
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: (): Promise<{ ok: true }> => mockDispatchAppAction(),
}));
jest.mock('@/client/interface-tools-client', () => ({
  contributeInterfaceTools: (): (() => void) => (): void => undefined,
}));

jest.mock('@/stores/appAdvisorStore', () => ({
  useAppAdvisorStore: { getState: (): object => ({}) },
}));
jest.mock('@/stores/currentUiStateStore', () => ({
  useCurrentUiStateStore: {
    getState: (): object => ({
      recomputeEnvelope: (): void => undefined,
      getEnvelope: (): null => null,
    }),
  },
}));
jest.mock('@/lib/show-files', () => ({
  showFilesInRenderer: jest.fn(),
}));
jest.mock('@/lib/turn-file-viewer', () => ({
  onTurnFileViewerClosed: (): (() => void) => () => undefined,
  revealTurnFileTarget: jest.fn(),
}));

import { AppAdvisorMainRuntimeBridge } from '../AppAdvisorRuntimeBridge';

let root: Root;
let container: HTMLDivElement;
let emit: (request: AppAdvisorRendererToolRequest) => void = () => undefined;
const completed: AppAdvisorRendererToolResponse[] = [];

beforeEach(async () => {
  completed.length = 0;
  mockDispatchAppAction.mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appAdvisor: {
        onToolRequest: (
          listener: (request: AppAdvisorRendererToolRequest) => void,
        ): (() => void) => {
          emit = listener;
          return () => undefined;
        },
        completeToolRequest: (
          response: AppAdvisorRendererToolResponse,
        ): Promise<void> => {
          completed.push(response);
          return Promise.resolve();
        },
      },
    },
  });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root.render(<AppAdvisorMainRuntimeBridge />);
    await Promise.resolve();
  });
});
afterEach(() => {
  act(() => root.unmount());
});

async function deliver(request: AppAdvisorRendererToolRequest): Promise<void> {
  await act(async () => {
    emit(request);
    for (let tick = 0; tick < 10 && completed.length === 0; tick += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('App Advisor bridge presentation guard (CAN-4133)', () => {
  it('the bridge refuses a non-presentation action that arrives through the lease', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-1',
      action: { type: 'pipeline.create', name: 'Nightly' },
      originWorktreeId: 'global',
      interfaceToolCall: true,
    });

    expect(completed).toEqual([
      {
        requestId: 'call-1',
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Only navigation, panel and window actions run through this tool.',
        },
      },
    ]);
    expect(mockDispatchAppAction).not.toHaveBeenCalled();
  });

  it('a legacy delivery without the flag is unchanged', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-2',
      action: { type: 'pipeline.create', name: 'Nightly' },
      originWorktreeId: 'global',
    });

    expect(mockDispatchAppAction).toHaveBeenCalledTimes(1);
    expect(completed).toEqual([
      expect.objectContaining({ requestId: 'call-2', ok: true }),
    ]);
  });

  it('a model change main hands over when its guard fails runs in the window (CAN-5999 D3)', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-3',
      action: {
        type: 'worktree-chat.set_model',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        model: 'sonnet',
      },
      originWorktreeId: 'global',
      interfaceToolCall: true,
    });

    expect(mockDispatchAppAction).toHaveBeenCalledTimes(1);
    expect(completed).toEqual([
      expect.objectContaining({ requestId: 'call-3', ok: true }),
    ]);
  });

  it('a speed change is never handed to the window through the lease', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-4',
      action: {
        type: 'worktree-chat.set_speed',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        speed: 'fast',
      },
      originWorktreeId: 'global',
      interfaceToolCall: true,
    });

    expect(mockDispatchAppAction).not.toHaveBeenCalled();
    expect(completed).toEqual([
      expect.objectContaining({ requestId: 'call-4', ok: false }),
    ]);
  });

  it('an account MCP or Cursor request main hands over reaches its Settings surface (CAN-6008 B1)', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-5',
      action: { type: 'mcp.account_connect', serverId: 'srv-1' },
      originWorktreeId: 'global',
      interfaceToolCall: true,
    });

    expect(mockDispatchAppAction).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject([{ requestId: 'call-5', ok: true }]);
  });

  it('a credential write that runs in main is never handed to the window through the lease (CAN-6008)', async () => {
    await deliver({
      kind: 'dispatch_action',
      requestId: 'call-6',
      action: { type: 'canopy_cloud.save_api_key', apiKey: 'sk-test' },
      originWorktreeId: 'global',
      interfaceToolCall: true,
    });

    expect(mockDispatchAppAction).not.toHaveBeenCalled();
    expect(completed).toMatchObject([
      { requestId: 'call-6', ok: false, error: { code: 'unsupported_action' } },
    ]);
  });
});
