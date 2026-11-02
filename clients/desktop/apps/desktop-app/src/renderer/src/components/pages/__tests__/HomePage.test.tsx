/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Zustand from 'zustand';

jest.mock('@/stores/projectsStore', () => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  return {
    useProjectsStore: create(() => ({
      hasHydratedProjects: true,
      projects: [],
    })),
  };
});
jest.mock('../../home/HomeSurface', () => ({
  HomeSurface: (): JSX.Element => <div data-testid="home-surface" />,
}));
jest.mock('../../onboarding/FirstRunImportPage', () => ({
  FirstRunImportPage: (): JSX.Element => <div data-testid="first-run" />,
}));

import { HomePage } from '../HomePage';
import { useProjectsStore } from '@/stores/projectsStore';

describe('HomePage first-run gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useProjectsStore.setState({ hasHydratedProjects: true, projects: [] });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    Reflect.deleteProperty(window, 'localPlatform');
  });

  function setPreferences(load: () => Promise<unknown>): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadPreferences: jest.fn(load) },
    });
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<HomePage />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  const shown = (id: string): boolean =>
    container.querySelector(`[data-testid="${id}"]`) !== null;

  it.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'only adds the drag-only overlay without a local %s native frame',
    async (platform) => {
      Object.defineProperty(window, 'localPlatform', {
        configurable: true,
        writable: true,
        value: platform,
      });
      setPreferences(() => Promise.resolve({ onboardingCompleted: ['done'] }));
      await render();
      expect(shown('home-titlebar-drag-region')).toBe(platform !== 'linux');
      expect(shown('home-surface')).toBe(true);
    },
  );

  it('keeps the first-run page while its import adds projects', async () => {
    setPreferences(() => Promise.resolve({ onboardingCompleted: [] }));
    await render();
    expect(shown('first-run')).toBe(true);

    await act(async () => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'imported',
            name: 'Imported project',
            type: 'single-repo',
            repoPath: '/repo/imported',
            color: '#6366f1',
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      await Promise.resolve();
    });

    expect(shown('first-run')).toBe(true);
  });

  it('shows Home when preferences fail to load', async () => {
    setPreferences(() => Promise.reject(new Error('unreadable')));
    await render();

    expect(shown('first-run')).toBe(false);
    expect(shown('home-surface')).toBe(true);
  });
});
