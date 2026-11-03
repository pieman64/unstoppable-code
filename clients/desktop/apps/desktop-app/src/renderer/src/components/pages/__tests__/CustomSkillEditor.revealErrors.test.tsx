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

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

import { CustomSkillEditor } from '../SkillsTab';

/**
 * Save stays pressable while a field is invalid, so pressing it must bring
 * the field that blocks the save back into view: the edit form is hidden
 * while a supporting file tab or Preview is open, and metadata errors show
 * only inside Advanced.
 */
describe('CustomSkillEditor: Save reveals the field that blocks it', () => {
  let container: HTMLDivElement;
  let root: Root;
  const saveCustomSkill = jest.fn();
  let frontmatter: Record<string, unknown>;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const query = (selector: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(selector);
  const fieldError = (field: string): HTMLElement | null =>
    query(`[data-testid="skill-editor-${field}-field-error"]`);
  const nameInput = (): HTMLElement | null =>
    query('[data-testid="skill-editor-name-field"] input');
  const press = async (testId: string): Promise<void> => {
    await act(async () => {
      requireByTestId(testId).click();
      await flush();
    });
  };

  async function renderEditor(): Promise<void> {
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
  }

  beforeEach(() => {
    saveCustomSkill.mockReset();
    frontmatter = {
      name: 'release-notes',
      description: 'Drafts release notes.',
    };
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent: (): Promise<unknown> =>
          Promise.resolve({
            success: true,
            data: { frontmatter, body: 'Body' },
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('leaves an open file tab to show and focus the name error', async () => {
    await renderEditor();
    const name = nameInput();
    if (!(name instanceof HTMLInputElement)) {
      throw new Error('Expected the skill name input');
    }
    await act(async () => {
      setNativeInputValue(name, '');
      await flush();
    });
    await press('skill-editor-add-file');
    expect(nameInput()).toBeNull();

    await press('skill-editor-save');

    expect(saveCustomSkill).not.toHaveBeenCalled();
    expect(fieldError('name')).not.toBeNull();
    expect(nameInput()).not.toBeNull();
    expect(document.activeElement).toBe(nameInput());
  });

  it('leaves Preview to show and focus the description error', async () => {
    await renderEditor();
    const description = requireByTestId('skill-editor-description-input');
    if (!(description instanceof HTMLTextAreaElement)) {
      throw new Error('Expected the description textarea');
    }
    await act(async () => {
      setNativeInputValue(description, '');
      await flush();
    });
    await press('skill-editor-mode-preview');
    expect(query('[data-testid="skill-editor-description-input"]')).toBeNull();

    await press('skill-editor-save');

    expect(saveCustomSkill).not.toHaveBeenCalled();
    expect(fieldError('description')?.textContent).toContain(
      'Enter a description.',
    );
    expect(document.activeElement).toBe(
      query('[data-testid="skill-editor-description-input"]'),
    );
  });

  it('opens Advanced to show the metadata error', async () => {
    frontmatter = { ...frontmatter, 'bad key': 'value' };
    await renderEditor();
    const advanced = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Advanced metadata'),
    );
    if (!advanced) throw new Error('Expected the Advanced metadata toggle');
    await act(async () => {
      advanced.click();
      await flush();
    });
    expect(query('#skill-metadata-error')).toBeNull();
    expect(query('input[aria-label="Metadata key"]')).toBeNull();

    await press('skill-editor-save');

    expect(saveCustomSkill).not.toHaveBeenCalled();
    expect(query('#skill-metadata-error')?.textContent).toContain(
      'Metadata key "bad key" cannot contain whitespace.',
    );
    expect(document.activeElement).toBe(
      query('input[aria-label="Metadata key"]'),
    );
  });
});
