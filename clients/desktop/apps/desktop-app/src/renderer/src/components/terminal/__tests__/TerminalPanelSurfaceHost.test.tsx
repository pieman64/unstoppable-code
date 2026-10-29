/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { TerminalPanelSurfaceProps } from '@canopy/ui-app/terminal';
import type { LoadWorktreeTerminalStateResponse } from '@canopy/protocol/terminal';
import { brandText } from '@/lib/brand';
import { TerminalPanelSurface } from '../TerminalPanelSurface';
import type * as Materialization from '../terminalPanelMaterialization';
import {
  bindTerminalClient,
  useTerminalStore,
} from '@canopy/app-state/terminal';
import { createFakeTerminalClient } from '../../../../../../../../packages/app-state/src/terminal/__tests__/fake-terminal-client';

let mockProps: TerminalPanelSurfaceProps | undefined;
const mockBind = jest.fn<unknown, unknown[]>(() => ({}));
const mockGetBinding = jest.fn<string, unknown[]>(() => 'old');
const mockPrepare = jest.fn<Promise<void>, unknown[]>(() => Promise.resolve());
const mockOnSendToChat = jest.fn();
const mockGetPath = jest.fn(() => Promise.resolve(['/native/file']));
jest.mock('@canopy/ui-app/terminal', () => ({
  TerminalPanelSurface: (props: TerminalPanelSurfaceProps): JSX.Element => {
    mockProps = props;
    return <div />;
  },
}));
jest.mock('@/lib/panels/terminal-panel-activation', () => ({
  getTerminalPanelBinding: (...args: unknown[]): unknown =>
    mockGetBinding(...args),
  findTerminalPanelSource: (): unknown => ({
    layoutKey: 'aux',
    groupId: 'group',
  }),
  ensureTerminalPanelVisible: (...args: unknown[]): unknown =>
    mockBind(...args),
}));
jest.mock('../terminalPanelMaterialization', () => ({
  ensureLegacyTerminalPanelsMaterialized: (...args: unknown[]): unknown =>
    mockPrepare(...args),
}));
jest.mock('../useDesktopTerminalHostCallbacks', () => ({
  useDesktopTerminalHostCallbacks: (): unknown => ({
    onSendToChat: mockOnSendToChat,
    getPathsForFiles: mockGetPath,
  }),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

it('adapts desktop bindings, preparation, branding and pane callbacks', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <TerminalPanelSurface
        projectId="p"
        worktreeId="w"
        panelId="panel"
        terminalId="old"
        active
      />,
    ),
  );
  try {
    if (!mockProps) throw new Error('Missing shared surface');
    expect(mockProps).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      panelId: 'panel',
      terminalId: 'old',
      active: true,
      appName: brandText.appName,
      onSendToChat: mockOnSendToChat,
      getPathsForFiles: mockGetPath,
    });
    expect(mockProps.host.getBinding('p/w', 'panel')).toBe('old');
    expect(mockGetBinding).toHaveBeenCalledWith('p/w', 'panel');
    await mockProps.host.prepareWorktree?.('p', 'w', 'p/w');
    expect(mockPrepare).toHaveBeenCalledWith('p', 'w', 'p/w');
    const session = {
      id: 'new',
      projectId: 'p',
      worktreeId: 'w',
      shell: 'zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
      title: '  custom  ',
    };
    expect(mockProps.host.bindTerminal('p/w', 'panel', session)).toBe(true);
    expect(mockBind).toHaveBeenCalledWith(
      'p/w',
      { layoutKey: 'aux', groupId: 'group' },
      { terminalId: 'new', title: 'custom', focus: true },
    );
    mockBind.mockReturnValueOnce(null);
    expect(
      mockProps.host.bindTerminal('p/w', 'panel', { ...session, title: '' }),
    ).toBe(false);
    expect(mockBind).toHaveBeenLastCalledWith('p/w', expect.any(Object), {
      terminalId: 'new',
      title: 'Terminal',
      focus: true,
    });
  } finally {
    act(() => root.unmount());
  }
});

it('materializes legacy sessions only once per worktree through the desktop host', async () => {
  const materialization = jest.requireActual<typeof Materialization>(
    '../terminalPanelMaterialization',
  );
  materialization.resetTerminalPanelMaterializationForTesting();
  const dispose = bindTerminalClient(createFakeTerminalClient().client);
  mockBind.mockClear();
  try {
    for (const id of ['first', 'second']) {
      useTerminalStore.getState().addGroupWithTerminal({
        id,
        projectId: 'p',
        worktreeId: 'w',
        shell: 'zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      });
    }
    await Promise.all([
      materialization.ensureLegacyTerminalPanelsMaterialized('p', 'w', 'p/w'),
      materialization.ensureLegacyTerminalPanelsMaterialized('p', 'w', 'p/w'),
    ]);
    expect(mockBind).toHaveBeenCalledTimes(2);
    expect(mockBind).toHaveBeenCalledWith('p/w', undefined, {
      terminalId: 'first',
      title: 'Terminal',
      focus: false,
    });
    expect(mockBind).toHaveBeenCalledWith('p/w', undefined, {
      terminalId: 'second',
      title: 'Terminal',
      focus: false,
    });
  } finally {
    dispose();
    materialization.resetTerminalPanelMaterializationForTesting();
  }
});

it('hydrates the desktop host again after its terminal binding is replaced', async () => {
  const materialization = jest.requireActual<typeof Materialization>(
    '../terminalPanelMaterialization',
  );
  const first = createFakeTerminalClient();
  const disposeFirst = bindTerminalClient(first.client);
  await materialization.ensureLegacyTerminalPanelsMaterialized('p', 'w', 'p/w');
  const second = createFakeTerminalClient();
  const disposeSecond = bindTerminalClient(second.client);
  try {
    await materialization.ensureLegacyTerminalPanelsMaterialized(
      'p',
      'w',
      'p/w',
    );

    expect(
      second.calls.queries['terminal.worktreeState.get'],
    ).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().worktrees['p/w']?.hydrated).toBe(true);
  } finally {
    disposeFirst();
    disposeSecond();
    materialization.resetTerminalPanelMaterializationForTesting();
  }
});

it('does not materialize a new binding from an old pending hydration', async () => {
  const materialization = jest.requireActual<typeof Materialization>(
    '../terminalPanelMaterialization',
  );
  const first = createFakeTerminalClient();
  let resolveState:
    | ((value: LoadWorktreeTerminalStateResponse) => void)
    | undefined;
  first.calls.queries['terminal.worktreeState.get'].mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveState = resolve;
      }),
  );
  const disposeFirst = bindTerminalClient(first.client);
  const pending = materialization.ensureLegacyTerminalPanelsMaterialized(
    'p',
    'w',
    'p/w',
  );
  const second = createFakeTerminalClient();
  const disposeSecond = bindTerminalClient(second.client);
  mockBind.mockClear();
  try {
    useTerminalStore.getState().addGroupWithTerminal({
      id: 'new',
      projectId: 'p',
      worktreeId: 'w',
      shell: 'zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
    });
    resolveState?.(
      await second.calls.queries['terminal.worktreeState.get']({
        projectId: 'p',
        worktreeId: 'w',
      }),
    );
    await pending;

    expect(mockBind).not.toHaveBeenCalled();
  } finally {
    disposeFirst();
    disposeSecond();
    materialization.resetTerminalPanelMaterializationForTesting();
  }
});
