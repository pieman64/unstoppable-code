/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { MemoryPanel } from '@canopy/ui-app/local-memory';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';
import { useProjectsStore } from '@/stores/projectsStore';
import { MemorySection } from '../MemorySection';

jest.mock('@canopy/ui-app/local-memory', () => ({
  MemoryPanel: jest.fn((): null => null),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function lastProps(): Parameters<typeof MemoryPanel>[0] {
  const calls = jest.mocked(MemoryPanel).mock.calls;
  return calls[calls.length - 1][0];
}

describe('MemorySection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    const project: SidebarItem = {
      type: 'single-repo',
      id: 'project-one',
      name: 'canopy',
      repoPath: '/workspace',
      color: '#000000',
      collapsed: false,
      order: 0,
      worktrees: [],
    };
    useProjectsStore.setState({ projects: [project] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(['body-only', 'frameless'] as const)(
    'lists memories for every project and this project in %s chrome',
    (chrome) => {
      act(() => {
        root.render(
          <ActivitySectionChromeContext.Provider value={chrome}>
            <MemorySection projectId="project-one" worktreeId="worktree-one" />
          </ActivitySectionChromeContext.Provider>,
        );
      });
      expect(lastProps()).toMatchObject({
        scopes: [
          {
            scope: { scope: 'user' },
            label: 'Everywhere',
            savedFor: 'Every project',
          },
          {
            scope: { scope: 'workspace', workspaceId: 'project-one' },
            label: 'canopy',
            savedFor: 'canopy',
          },
        ],
        showSettingsLink: true,
        hideWhenEmpty: false,
      });
      act(() => {
        root.render(
          <ActivitySectionChromeContext.Provider value={chrome}>
            <MemorySection projectId="cowork-two" worktreeId="entry-two" />
          </ActivitySectionChromeContext.Provider>,
        );
      });
      expect(lastProps().scopes[1]).toMatchObject({
        scope: { scope: 'workspace', workspaceId: 'cowork-two' },
        label: 'This project',
      });
    },
  );

  it('lists only memories for every project without a memory workspace', () => {
    act(() => {
      root.render(<MemorySection projectId="" worktreeId="worktree-one" />);
    });
    expect(lastProps().scopes).toEqual([
      {
        scope: { scope: 'user' },
        label: 'Everywhere',
        savedFor: 'Every project',
      },
    ]);
  });

  it('lists only the project memories for a private-memory project', () => {
    useProjectsStore.setState({
      projects: useProjectsStore
        .getState()
        .projects.map((project) => ({ ...project, privateMemory: true })),
    });
    act(() => {
      root.render(
        <MemorySection projectId="project-one" worktreeId="worktree-one" />,
      );
    });
    expect(lastProps().scopes).toEqual([
      {
        scope: { scope: 'workspace', workspaceId: 'project-one' },
        label: 'canopy',
        savedFor: 'canopy',
      },
    ]);
  });

  it('hides while empty when the activity rail tracks emptiness', () => {
    const onEmptyChange = jest.fn();
    act(() => {
      root.render(
        <MemorySection
          projectId="project-one"
          worktreeId="worktree-one"
          onEmptyChange={onEmptyChange}
        />,
      );
    });
    expect(lastProps()).toMatchObject({ hideWhenEmpty: true, onEmptyChange });
  });
});
