/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Zustand from 'zustand';

jest.mock('@/stores/projectsStore', () => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  return {
    useProjectsStore: create(() => ({
      hasHydratedProjects: true,
      projects: [] as { id: string }[],
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
  });

  function setPreferences(load: () => Promise<unknown>): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
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

  it('keeps the first-run page while its import adds projects', async () => {
    setPreferences(() => Promise.resolve({ onboardingCompleted: [] }));
    await render();
    expect(shown('first-run')).toBe(true);

    await act(async () => {
      useProjectsStore.setState({ projects: [{ id: 'imported' }] });
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
