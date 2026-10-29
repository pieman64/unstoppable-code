/**
 * @jest-environment jsdom
 *
 * The Cowork top bar names the project in its breadcrumb pill.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { CoworkTopBar } from '../CoworkTopBar';

jest.mock('@/components/sidebar/CollapsedTitlebarToggle', () => ({
  CollapsedTitlebarToggle: (): null => null,
}));
jest.mock('@/components/worktree/OpenDropdown', () => ({
  OpenDropdown: (): null => null,
}));
jest.mock('@/components/panels/WorkspaceLayoutControls', () => ({
  WorkspaceLayoutControls: (): null => null,
}));
jest.mock('@/components/standalone-chat/ChatProjectSettingsModal', () => ({
  ChatProjectSettingsModal: (): null => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CoworkTopBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useProjectsStore.setState({
      projects: [
        {
          id: 'cowork-1',
          type: 'cowork',
          name: 'Acme secret project',
          color: '#123456',
          collapsed: false,
          order: 0,
        },
      ],
    });
    useStandaloneChatStore.setState({
      activeWorkEntryId: 'entry-1',
      chatProjects: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the workspace name in the breadcrumb pill', () => {
    act(() => root.render(<CoworkTopBar workspaceId="cowork-1" />));
    const name = container.querySelector(
      '[data-testid="cowork-top-workspace-name"]',
    );
    expect(name?.textContent).toBe('Acme secret project');
  });
});
