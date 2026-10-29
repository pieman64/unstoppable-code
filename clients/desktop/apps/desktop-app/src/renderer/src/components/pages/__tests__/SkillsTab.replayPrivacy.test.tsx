/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { setNativeInputValue } from '@/test-utils/dom';

const mockSkillList: {
  skills: InstalledSkillInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} = {
  skills: [],
  loading: false,
  error: null,
  refresh: () => Promise.resolve(),
};
jest.mock('../../../hooks/useSkillList', () => ({
  useSkillList: (): typeof mockSkillList => mockSkillList,
}));
jest.mock('../../../hooks/useSharedSkillList', () => ({
  useSharedSkillList: (): Record<string, unknown> => ({
    cloudAccount: null,
    cloudLoading: false,
    skills: [],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    error: null,
    loaded: false,
    refreshShared: (): Promise<void> => Promise.resolve(),
    loadMoreShared: (): Promise<void> => Promise.resolve(),
    setFilters: (): void => {},
    removeSharedRow: (): void => {},
  }),
}));
jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): Record<string, unknown> => ({
    shareEnabled: false,
    requestShare: (): void => {},
    shareGateModal: null,
  }),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));
jest.mock('@canopy/ui-app', () => ({
  SkillReadDetail: ({ error }: { error: string }): ReactElement => (
    <div role="alert">{error}</div>
  ),
  MarkdownFrontmatterContent: (): null => null,
}));

import {
  AddSkillsModal,
  CustomSkillEditor,
  SkillDetailModal,
} from '../SkillsTab';

describe('SkillsTab session replay privacy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('records the skill edit form and blocks the preview', async () => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent: (): Promise<unknown> =>
          Promise.resolve({
            success: true,
            data: {
              frontmatter: {
                name: 'acquisition-memo',
                description: 'Drafts the acquisition memo.',
              },
              body: 'Secret body',
            },
          }),
        listFiles: (): Promise<unknown> =>
          Promise.resolve({
            success: true,
            data: { files: ['SKILL.md'], truncated: false },
          }),
        readFile: (): Promise<unknown> =>
          Promise.resolve({ success: false, error: 'unused' }),
      },
    });

    await act(async () => {
      root.render(
        <CustomSkillEditor
          editingName="acquisition-memo"
          presentation="modal"
          onClose={(): void => {}}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      );
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    const title = document.getElementById('create-skill-modal-title');
    expect(title?.textContent).toBe('Edit skill: acquisition-memo');
    expect(title?.closest('.ph-no-capture')).toBeNull();

    // Edit mode: the form is recorded; the recorder masks its input values.
    const bodyInput = document.querySelector('textarea[rows="18"]');
    expect(bodyInput).not.toBeNull();
    expect(bodyInput?.closest('.ph-no-capture')).toBeNull();
    expect(
      document
        .querySelector('[data-testid="skill-editor-pane"]')
        ?.classList.contains('ph-no-capture'),
    ).toBe(false);
    // The Edit/Preview toggle and Save action stay recorded.
    expect(
      document
        .querySelector('[data-testid="skill-editor-mode-preview"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();
    expect(
      document
        .querySelector('[data-testid="skill-editor-save"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();

    // Preview mode: the rendered SKILL.md pane mounts blocked.
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="skill-editor-mode-preview"]',
        )
        ?.click();
    });
    expect(
      document
        .querySelector('[data-testid="skill-editor-pane"]')
        ?.classList.contains('ph-no-capture'),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-testid="skill-editor-mode-edit"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();
  });

  it('names the repository in the fetching label', async () => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        fetchAvailable: (): Promise<unknown> => new Promise(() => {}),
      },
    });

    await act(async () => {
      root.render(
        <AddSkillsModal
          isOpen
          onClose={(): void => {}}
          onInstalled={(): Promise<void> => Promise.resolve()}
        />,
      );
      await Promise.resolve();
    });

    const input = document.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('No input');
    await act(async () => {
      setNativeInputValue(input, 'acme/private-skills');
      await Promise.resolve();
    });
    const find = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Find skills',
    );
    await act(async () => {
      find?.click();
      await Promise.resolve();
    });

    const label = Array.from(document.querySelectorAll('p')).find(
      (el) =>
        el.textContent === 'Fetching skills from acme/private-skills\u2026',
    );
    expect(label).toBeDefined();
  });
  it('explains a successful update when reloading its content fails', async () => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent: () =>
          Promise.resolve({ success: false, error: 'Read unavailable' }),
        listFiles: () =>
          Promise.resolve({
            success: true,
            data: { files: [], truncated: false },
          }),
      },
    });
    await act(async () => {
      root.render(
        <SkillDetailModal
          skill={{ sourceId: 'github:owner:repo', name: 'review' }}
          onClose={() => {}}
          loadErrorPrefix="The skill was updated, but the latest version couldn’t be loaded. Reopen the skill to see it."
        />,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'The skill was updated, but the latest version couldn’t be loaded.',
    );
    expect(document.body.textContent).toContain('Read unavailable');
  });
});
