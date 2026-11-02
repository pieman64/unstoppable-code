/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

// The desktop Cost and Session breakdown panel hosts mount the shared views
// over `window.api.cost` and report the open panel to App Advisor, with
// Early access off.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import {
  createEmptyCostTotals,
  type CostScopeView,
  type CostViewResult,
} from '@canopy/protocol/cost-view';
import type { CostApi } from '@canopy/desktop-shared/types';
import {
  createDesktopCapabilities,
  IpcCanopyClient,
} from '@/client/ipc-canopy-client';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

import { CostPanelHost } from '../CostPanelHost';
import { SessionBreakdownPanelHost } from '../../session-breakdown/SessionBreakdownPanelHost';

const SCOPE_VIEW: CostScopeView = {
  scope: { kind: 'entry', projectId: 'p-1', worktreeId: 'w-1' },
  updatedAt: '2026-10-08T12:00:00.000Z',
  building: false,
  retentionDays: 7,
  totals: createEmptyCostTotals(),
  chats: [],
  pipelineRuns: [],
  hasCodexEstimate: false,
};

const noScopeChatResult = {
  status: 'unavailable',
  reason: 'no_scope',
} satisfies Awaited<ReturnType<CostApi['getChat']>>;

function costApi(): CostApi & {
  readonly getScope: jest.Mock<
    ReturnType<CostApi['getScope']>,
    Parameters<CostApi['getScope']>
  >;
  readonly getChat: jest.Mock<
    ReturnType<CostApi['getChat']>,
    Parameters<CostApi['getChat']>
  >;
} {
  const ok: CostViewResult<CostScopeView> = { status: 'ok', value: SCOPE_VIEW };
  return {
    getScope: jest.fn<
      ReturnType<CostApi['getScope']>,
      Parameters<CostApi['getScope']>
    >(() => Promise.resolve(ok)),
    getChat: jest.fn<
      ReturnType<CostApi['getChat']>,
      Parameters<CostApi['getChat']>
    >(() => Promise.resolve(noScopeChatResult)),
    getPipelineRun: jest.fn(() =>
      Promise.resolve({ status: 'unavailable', reason: 'no_scope' }),
    ),
    refresh: jest.fn(() =>
      Promise.resolve({ status: 'unavailable', reason: 'no_scope' }),
    ),
    watchScope: jest.fn(() => () => undefined),
    onUpdated: jest.fn(() => () => undefined),
  };
}

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof costApi>;

function render(node: React.ReactNode): void {
  const client = new IpcCanopyClient(createDesktopCapabilities('darwin'));
  act(() => {
    root.render(
      <CanopyClientProvider client={client}>{node}</CanopyClientProvider>,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  api = costApi();
  Object.assign(window, { api: { ...window.api, cost: api } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  useCurrentUiStateStore.setState({ slices: {} });
});

describe('CostPanelHost', () => {
  it('mounts the shared Cost view and reports the panel with Early access off', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    render(<CostPanelHost projectId="p-1" worktreeId="w-1" />);
    await flush();
    expect(api.getScope).toHaveBeenCalledWith({
      scope: { kind: 'entry', projectId: 'p-1', worktreeId: 'w-1' },
    });
    expect(
      container.querySelector('[data-testid="cost-scope-view"]'),
    ).not.toBeNull();
    expect(
      useCurrentUiStateStore.getState().slices['cost.panel.cost/p-1/w-1'],
    ).toEqual({
      kind: 'cost',
      projectId: 'p-1',
      worktreeId: 'w-1',
      status: 'ready',
      building: false,
      chatCount: 0,
      pipelineRunCount: 0,
    });
  });
});

describe('SessionBreakdownPanelHost', () => {
  it('reads the bound chat and reports it with Early access off', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    render(
      <SessionBreakdownPanelHost
        projectId="p-1"
        worktreeId="w-1"
        chatId="c-1"
      />,
    );
    await flush();
    expect(api.getChat).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'entry', projectId: 'p-1', worktreeId: 'w-1' },
        chatId: 'c-1',
      }),
    );
    expect(
      useCurrentUiStateStore.getState().slices[
        'cost.panel.session-breakdown/p-1/w-1/c-1'
      ],
    ).toMatchObject({
      kind: 'session-breakdown',
      chatId: 'c-1',
    });
  });
});
