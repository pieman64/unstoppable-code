/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RecommendedPluginItem } from '@canopy/desktop-shared/types';
import { RecommendedPluginsSettingsPanel } from '../RecommendedPluginsSettingsPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const applyRecommendedPlugins = jest.fn();
const inspectRecommendedPlugins = jest.fn();

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ applyRecommendedPlugins }),
}));

function item(
  key: string,
  overrides: Partial<RecommendedPluginItem> = {},
): RecommendedPluginItem {
  return {
    key,
    kind: 'skill',
    displayName: key,
    displaySource: 'github.com/acme/skills',
    ref: {
      type: 'skill',
      source: { type: 'github', repo: 'acme/skills' },
      skill_name: key,
    },
    installed: true,
    selectedByDefault: false,
    optedOut: false,
    installState: 'installed',
    action: 'select',
    ...overrides,
  };
}

describe('RecommendedPluginsSettingsPanel compact variant', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    Reflect.set(window, 'api', { inspectRecommendedPlugins });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderCompact(worktreeId: string | undefined): Promise<void> {
    act(() => {
      root.render(
        <RecommendedPluginsSettingsPanel
          projectId="project-1"
          worktreeId={worktreeId}
          variant="compact"
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders nothing without a worktree', async () => {
    await renderCompact(undefined);

    expect(container.innerHTML).toBe('');
    expect(inspectRecommendedPlugins).not.toHaveBeenCalled();
  });

  it('renders nothing when canopy.json recommends nothing', async () => {
    inspectRecommendedPlugins.mockResolvedValue({ items: [] });

    await renderCompact('worktree-1');

    expect(container.innerHTML).toBe('');
  });

  it('summarises recommendations on one line and expands the rows on Review', async () => {
    inspectRecommendedPlugins.mockResolvedValue({
      items: [
        item('alpha', { selectedByDefault: true, action: 'none' }),
        item('beta'),
        item('gamma'),
      ],
    });

    await renderCompact('worktree-1');

    const strip = container.querySelector(
      '[data-testid="recommended-plugins-strip"]',
    );
    expect(strip?.textContent).toContain(
      'canopy.json recommends 3 items · 2 not selected',
    );
    expect(container.querySelector('li')).toBeNull();

    const review = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Review'),
    );
    expect(review?.getAttribute('aria-expanded')).toBe('false');

    act(() => review?.click());
    expect(review?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).toContain('Select by default');

    act(() => review?.click());
    expect(review?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('li')).toBeNull();
  });

  it('drops the not-selected count when every recommendation is selected', async () => {
    inspectRecommendedPlugins.mockResolvedValue({
      items: [item('alpha', { selectedByDefault: true, action: 'none' })],
    });

    await renderCompact('worktree-1');

    const strip = container.querySelector(
      '[data-testid="recommended-plugins-strip"]',
    );
    expect(strip?.textContent).toContain('canopy.json recommends 1 item');
    expect(strip?.textContent).not.toContain('not selected');
  });

  it('shows a load failure as a single line', async () => {
    inspectRecommendedPlugins.mockRejectedValue(new Error('boom'));

    await renderCompact('worktree-1');

    expect(
      container.querySelector('[data-testid="recommended-plugins-strip"]')
        ?.textContent,
    ).toBe('Failed to load recommended plugins.');
  });
});
