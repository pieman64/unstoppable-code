/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as UiApp from '@canopy/ui-app';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { InstalledShareProvenanceOptions } from '@canopy/ui-app/capability';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));
jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<typeof UiApp>('@canopy/ui-app'),
  MarkdownFrontmatterContent: (): null => null,
}));

import { SkillDetailModal } from '../SkillsTab';

const installedSkill: InstalledSkillInfo = {
  sourceId: 'custom:app',
  name: 'review',
  description: '',
  source: 'Custom skills',
  installedAt: '2026-10-14T12:00:00.000Z',
  updatedAt: '2026-10-20T12:00:00.000Z',
  updateAvailable: false,
  custom: true,
  installedFromShare: {
    remoteId: 's1',
    shareScope: 'team',
    contentHash: 'a'.repeat(64),
  },
};

describe('SkillDetailModal shared copy Update (CAN-5306)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent: () =>
          Promise.resolve({
            success: true,
            data: { frontmatter: {}, body: 'Body' },
          }),
        listFiles: () =>
          Promise.resolve({
            success: true,
            data: { files: [], truncated: false },
          }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    presentation: 'page' | 'modal',
    shareProvenance: InstalledShareProvenanceOptions,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SkillDetailModal
          presentation={presentation}
          skill={{ sourceId: 'custom:app', name: 'review' }}
          displayName="Review"
          installedSkill={installedSkill}
          shareProvenance={shareProvenance}
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });
  }

  function all(testId: string): Element[] {
    return Array.from(
      document.body.querySelectorAll(`[data-testid="${testId}"]`),
    );
  }

  function menuTestIds(): string[] {
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-more"]',
    );
    if (!trigger) return [];
    act(() => trigger.click());
    return Array.from(
      document.body.querySelectorAll(
        '[data-testid="skill-read-detail-menu"] [data-testid^="skill-read-detail-"]',
      ),
    ).map((item) => item.getAttribute('data-testid') ?? '');
  }

  it.each(['page', 'modal'] as const)(
    'makes Update primary and moves Try it first into the menu (%s)',
    async (presentation) => {
      const onUpdate = jest.fn();
      await render(presentation, { updateAvailable: true, onUpdate });
      const update = all('installed-share-update');
      expect(update).toHaveLength(1);
      expect(update[0]?.getAttribute('aria-label')).toBe('Update Review');
      expect(all('detail-primary-cta')).toHaveLength(0);
      expect(all('skill-update-notice')).toHaveLength(0);
      act(() => (update[0] as HTMLButtonElement).click());
      expect(onUpdate).toHaveBeenCalledTimes(1);
      const items = menuTestIds();
      expect(items[0]).toBe('skill-read-detail-try-it');
      expect(items.filter((id) => id === 'skill-read-detail-try-it')).toEqual([
        'skill-read-detail-try-it',
      ]);
      expect(all('installed-share-update')).toHaveLength(1);
    },
  );

  it('shows the combined status and date on the page', async () => {
    await render('page', { updateAvailable: true, onUpdate: jest.fn() });
    const status = all('installed-share-status');
    expect(status).toHaveLength(1);
    expect(status[0]?.textContent).toMatch(/^Update available·Installed .+$/);
    expect(document.body.textContent).not.toContain('Updated ');
  });

  it.each([
    ['no known update', {}],
    ['an update without a supported review', { updateAvailable: true }],
  ])('keeps Try it primary for %s', async (_case, shareProvenance) => {
    await render('page', shareProvenance);
    expect(all('installed-share-update')).toHaveLength(0);
    expect(all('detail-primary-cta')).toHaveLength(1);
    expect(menuTestIds()).not.toContain('skill-read-detail-try-it');
  });
});
