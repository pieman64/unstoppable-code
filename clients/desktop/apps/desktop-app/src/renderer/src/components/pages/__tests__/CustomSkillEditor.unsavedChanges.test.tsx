/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { requireByTestId, setNativeInputValue } from '@/test-utils/dom';
import { useNavigationStore } from '@/stores/navigationStore';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

import { CustomSkillEditor } from '../SkillsTab';

/**
 * The skill edit page asks through the shared unsaved-changes guard before
 * the Customize row returns to its root (2026-10-22).
 */
describe('CustomSkillEditor page: leaving with unsaved changes', () => {
  let container: HTMLDivElement;
  let root: Root;
  const saveCustomSkill = jest.fn();

  const store = (): ReturnType<typeof useNavigationStore.getState> =>
    useNavigationStore.getState();
  const dialog = (): Element | null =>
    document.querySelector('[data-testid="workflows-unsaved-dialog"]');
  const description = (): HTMLTextAreaElement => {
    const element = requireByTestId('skill-editor-description-input');
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('Expected the description textarea');
    }
    return element;
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  beforeEach(async () => {
    saveCustomSkill.mockReset();
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent: (): Promise<unknown> =>
          Promise.resolve({
            success: true,
            data: {
              frontmatter: {
                name: 'release-notes',
                description: 'Drafts release notes.',
              },
              body: 'Body',
            },
          }),
        listFiles: (): Promise<unknown> =>
          Promise.resolve({
            success: true,
            data: { files: ['SKILL.md'], truncated: false },
          }),
        readFile: (): Promise<unknown> =>
          Promise.resolve({ success: false, error: 'unused' }),
        saveCustomSkill,
      },
    });
    useNavigationStore.setState({
      activePage: 'plugins',
      pluginsBrowseSectionId: null,
      sectionRootRequest: 0,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <CustomSkillEditor
          editingName="release-notes"
          presentation="page"
          onClose={(): void => {}}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      );
      await flush();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function edit(): Promise<void> {
    await act(async () => {
      setNativeInputValue(description(), 'Drafts better release notes.');
      await flush();
    });
  }

  it('returns a clean editor to the Customize root without asking', async () => {
    await act(async () => {
      store().returnToSectionRoot('plugins');
      await flush();
    });
    expect(dialog()).toBeNull();
    expect(store().sectionRootRequest).toBe(1);
  });

  it('dirty editor shows the confirm', async () => {
    await edit();
    await act(async () => {
      store().returnToSectionRoot('plugins');
      await flush();
    });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Save changes to “release-notes”?');
    expect(store().sectionRootRequest).toBe(0);
  });

  it('Stay keeps you and your changes', async () => {
    await edit();
    await act(async () => {
      store().returnToSectionRoot('plugins');
      await flush();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await flush();
    });
    expect(dialog()).toBeNull();
    expect(store().sectionRootRequest).toBe(0);
    expect(description().value).toBe('Drafts better release notes.');
    expect(saveCustomSkill).not.toHaveBeenCalled();
  });

  it('Discard navigates to the root', async () => {
    await edit();
    await act(async () => {
      store().returnToSectionRoot('plugins');
      await flush();
    });
    await act(async () => {
      requireByTestId('workflows-unsaved-discard').click();
      await flush();
    });
    expect(dialog()).toBeNull();
    expect(store().sectionRootRequest).toBe(1);
    expect(saveCustomSkill).not.toHaveBeenCalled();
  });

  it('says why when Save in the prompt cannot save yet', async () => {
    await act(async () => {
      setNativeInputValue(description(), '');
      await flush();
    });
    await act(async () => {
      store().returnToSectionRoot('plugins');
      await flush();
    });
    await act(async () => {
      requireByTestId('workflows-unsaved-save').click();
      await flush();
    });

    expect(saveCustomSkill).not.toHaveBeenCalled();
    expect(store().sectionRootRequest).toBe(0);
    expect(container.textContent).toContain(
      "This skill can't be saved yet. Check its name, description, instructions and files.",
    );
  });
});
