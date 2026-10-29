/**
 * @jest-environment jsdom
 *
 * Session-replay privacy for the shared-container viewer header (CAN-3119):
 * the publisher's name is personal identity, so replay records a same-size
 * box for it while the title, View only and "Shared by" stay recorded.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/ui-app'),
  WorktreeTopBar: ({
    statusContent,
  }: {
    statusContent: ReactNode;
  }): JSX.Element => <div>{statusContent}</div>,
}));
jest.mock('@/components/panels/CoworkTopBar', () => ({
  CoworkTopBar: (): null => null,
}));
jest.mock('@/components/activity/WorktreeLaunchButton', () => ({
  WorktreeLaunchButton: (): null => null,
}));
jest.mock('@/components/panels/PanelGridSurface', () => ({
  PanelGridSurface: (): null => null,
}));
jest.mock('@/components/panels/WorkspaceLayoutControls', () => ({
  WorkspaceLayoutControls: (): null => null,
}));
jest.mock('@/components/sidebar/CollapsedTitlebarToggle', () => ({
  CollapsedTitlebarToggle: (): null => null,
}));
jest.mock('@/hooks/useCanopyDesktopSharedContainerRunEnabled', () => ({
  useCanopyDesktopSharedContainerRunEnabled: (): boolean => false,
}));
jest.mock('@/lib/shared-containers/panel-layout', () => ({
  repairSharedContainerPanelLayout: (): void => undefined,
  shouldCloseSharedContainerTerminalLayout: (): boolean => false,
}));
jest.mock('../useSharedContainerRun', () => ({
  useSharedContainerRun: (): { availability: string; status: null } => ({
    availability: 'unsupported',
    status: null,
  }),
}));
jest.mock('../ForkedContainerNotice', () => ({
  ForkedContainerNotice: (): null => null,
}));
jest.mock('../SharedContainerForkModal', () => ({
  SharedContainerForkModal: (): null => null,
}));
jest.mock('../SharedContainerRunPanel', () => ({
  SharedContainerRunPanel: (): null => null,
}));

import { outermostReplayBlock } from '@/test-utils/replay';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { SharedContainerWorkspace } from '../SharedContainerWorkspace';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSharedContainerReplicasStore.getState().reset();
  useSharedContainerReplicasStore.setState({
    entries: [
      {
        organizationId: 'org-1',
        ownerName: 'Dana',
        container: {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
          title: 'Checkout flow',
          revision: 3,
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
      },
    ],
    viewer: {
      containerId: 'container-1',
      organizationId: 'org-1',
      replica: null,
      openError: null,
      loading: true,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSharedContainerReplicasStore.getState().reset();
});

describe('SharedContainerWorkspace session-replay privacy', () => {
  it("blocks the publisher's name, not the title or the Shared by label", () => {
    act(() => {
      root.render(<SharedContainerWorkspace onClose={jest.fn()} />);
    });

    const status = container.querySelector(
      '[data-testid="shared-container-top-status"]',
    );
    expect(status).not.toBeNull();
    expect(outermostReplayBlock(status)).toBeNull();
    expect(
      outermostReplayBlock(
        container.querySelector('[data-testid="shared-container-title"]'),
      ),
    ).toBeNull();
    const sharedBy = Array.from(status?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'Shared by Dana',
    );
    expect(sharedBy).toBeDefined();
    expect(outermostReplayBlock(sharedBy)).toBeNull();
    const name = Array.from(sharedBy?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'Dana',
    );
    expect(outermostReplayBlock(name)?.textContent).toBe('Dana');
  });
});
