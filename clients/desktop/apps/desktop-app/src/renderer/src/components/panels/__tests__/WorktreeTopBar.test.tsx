/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see ModelPicker.test.tsx);
 * @testing-library/react is not installed. The heavy children (PrStatusBar,
 * WorktreeLaunchButton, ArchivedChatsControl, WorkspaceLayoutControls) are
 * stubbed, and the shared `@canopy/ui-app` bar frame is stubbed with a
 * slot-passthrough to keep this suite focused on the desktop wrapper. This
 * suite only covers
 * the desktop wrapper's own concern: reserving the persistent titlebar-corner
 * width so the sidebar-toggle overlay doesn't paint over the top bar's New Chat
 * control in either worktree layout. The shared component's own behavior is
 * covered in
 * packages/ui-app/src/code/shell/__tests__/WorktreeTopBar.test.tsx.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorktreeTopBar } from '../WorktreeTopBar';

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ createTab: jest.fn() }),
}));

jest.mock('@canopy/ui-app', () => ({
  WorktreeTopBar: ({
    leadingAccessory,
    archivedChatsControl,
    statusContent,
    launchControl,
    trailingAccessory,
  }: {
    leadingAccessory?: ReactNode;
    archivedChatsControl?: ReactNode;
    statusContent?: ReactNode;
    launchControl?: ReactNode;
    trailingAccessory?: ReactNode;
  }): unknown =>
    createElement(
      'div',
      { 'data-testid': 'stub-shared-worktree-top-bar' },
      leadingAccessory,
      archivedChatsControl,
      statusContent,
      launchControl,
      trailingAccessory,
    ),
}));

jest.mock('@/components/github/PrStatusBar', () => ({
  PrStatusBar: (): unknown =>
    createElement('div', { 'data-testid': 'stub-pr-status-bar' }),
}));

jest.mock('@/components/activity/WorktreeLaunchButton', () => ({
  WorktreeLaunchButton: (): unknown =>
    createElement('div', { 'data-testid': 'stub-launch-button' }),
}));

jest.mock('@/components/chat/ArchivedChatsControl', () => ({
  ArchivedChatsControl: (): unknown =>
    createElement('div', { 'data-testid': 'stub-archived-chats' }),
}));

jest.mock('@/components/panels/WorkspaceLayoutControls', () => ({
  WorkspaceLayoutControls: (): unknown =>
    createElement('div', { 'data-testid': 'stub-workspace-layout-controls' }),
}));

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

function spacer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="page-titlebar-spacer"]',
  );
}

describe('WorktreeTopBar titlebar-corner reservation', () => {
  const viewModes: ReadonlyArray<{
    name: string;
    viewMode: 'list' | 'kanban';
  }> = [
    { name: 'list view', viewMode: 'list' },
    {
      name: 'kanban view so New Chat stays clickable',
      viewMode: 'kanban',
    },
  ];

  it.each(viewModes)(
    'reserves the corner spacer in $name',
    ({ viewMode }): void => {
      render(
        <WorktreeTopBar
          projectId="proj"
          worktreeId="wt"
          viewMode={viewMode}
          viewModeReady
        />,
      );
      expect(spacer()).not.toBeNull();
      expect(spacer()?.className).toContain('sidebar-instant-interactions');
    },
  );
});
