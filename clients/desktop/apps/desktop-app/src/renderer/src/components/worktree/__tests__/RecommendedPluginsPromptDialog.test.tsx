/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PendingRecommendedPluginPrompt } from '@/stores/projectsStore';
import { RecommendedPluginsPromptDialog } from '../RecommendedPluginsPromptDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const applyRecommendedPlugins = jest.fn();
const dismissPendingRecommendedPluginPrompt = jest.fn();
const openSettings = jest.fn();
const openPluginsNavigation = jest.fn();

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      applyRecommendedPlugins,
      dismissPendingRecommendedPluginPrompt,
    }),
}));

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ openSettings, openPluginsNavigation }),
}));

describe('RecommendedPluginsPromptDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens the matching setup destination without blocking the dialog', () => {
    const prompt: PendingRecommendedPluginPrompt = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      scopeLabel: 'Project',
      items: [],
      requirements: [
        {
          id: 'linear',
          kind: 'mcp',
          displayName: 'linear',
          required: true,
          affectedSteps: [],
          setupHint: 'Connect Linear.',
          status: 'missing',
        },
        {
          id: 'node',
          kind: 'runtime',
          displayName: 'node',
          required: true,
          affectedSteps: [],
          setupHint: 'Install Node.js.',
          status: 'missing',
        },
      ],
    };

    act(() => root.render(<RecommendedPluginsPromptDialog prompt={prompt} />));

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="recommended-plugin-requirement-setup-linear"]',
        )
        ?.click();
    });
    expect(openPluginsNavigation).toHaveBeenCalledWith({
      kind: 'entry-detail',
      entryId: 'mcp-catalog:linear',
    });

    const environmentButton = Array.from(
      document.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Open environment setup');
    act(() => environmentButton?.click());
    expect(openSettings).toHaveBeenCalledWith('environment');
    expect(document.body.textContent).toContain(
      'Missing setup does not block applying recommendations.',
    );
  });
});
