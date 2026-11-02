/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  ImportPlanPicker,
  type ImportPlanFileRow,
  type ImportPlanPickerItem,
  type ImportPlanPickerProps,
  type ImportPlanSuggestion,
} from '../ImportPlanPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function file(
  name: string,
  overrides: Partial<ImportPlanFileRow> = {},
): ImportPlanFileRow {
  return {
    key: `repo-1:${name}`,
    filename: name,
    relativePath: `docs/${name}`,
    repoId: 'repo-1',
    repoName: 'canopy',
    filenameMatchedIndices: [],
    pathMatchedIndices: [],
    ...overrides,
  };
}

function suggestion(
  id: string,
  overrides: Partial<ImportPlanSuggestion> = {},
): ImportPlanSuggestion {
  return {
    id,
    sourceRepoId: 'repo-1',
    sourceFilePath: `plans/${id}.md`,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let props: ImportPlanPickerProps;

function baseProps(
  overrides: Partial<ImportPlanPickerProps> = {},
): ImportPlanPickerProps {
  return {
    suggestions: [],
    hiddenSuggestions: [],
    files: [],
    query: '',
    onQueryChange: jest.fn(),
    loading: false,
    error: null,
    importing: false,
    onImport: jest.fn(),
    onOpenTracked: jest.fn(),
    onDismissSuggestion: jest.fn(),
    onBrowse: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
}

function render(overrides: Partial<ImportPlanPickerProps> = {}): void {
  props = baseProps(overrides);
  act(() => {
    root.render(<ImportPlanPicker {...props} />);
  });
}

function rerender(overrides: Partial<ImportPlanPickerProps>): void {
  props = { ...props, ...overrides };
  act(() => {
    root.render(<ImportPlanPicker {...props} />);
  });
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function options(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

function importedNames(): string[] {
  return jest
    .mocked(props.onImport)
    .mock.calls.map(([item]) =>
      item.kind === 'file'
        ? `file:${item.file.filename}`
        : `suggestion:${item.suggestion.id}`,
    );
}

function selectedText(): string | null | undefined {
  return q('[role="option"][aria-selected="true"]')?.textContent;
}

function key(target: Element | null, keyName: string): void {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyName, bubbles: true }),
    );
  });
}

function click(target: Element | null, type = 'click'): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.useRealTimers();
});

describe('ImportPlanPicker', () => {
  it('names the dialog and lists chat suggestions before all files', () => {
    render({
      suggestions: [suggestion('rollout', { chatTitle: 'Fix checkout' })],
      files: [file('README.md')],
    });

    const dialog = q('[role="dialog"]');
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(labelId && document.getElementById(labelId)?.textContent).toBe(
      'Import plan',
    );
    expect(q('[role="listbox"]')).not.toBeNull();
    const groups = Array.from(container.querySelectorAll('[role="group"]'));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('From your chats');
    expect(groups[1]?.textContent).toContain('All files');
    expect(options()[0]?.textContent).toContain('rollout.md');
    expect(options()[0]?.textContent).toContain('plans · from Fix checkout');
    expect(selectedText()).toContain('rollout.md');
  });

  it('omits the suggestions group and selects the first file without one', () => {
    render({ files: [file('plan.md'), file('notes.md')] });

    expect(q('[data-testid="import-plan-suggestions-group"]')).toBeNull();
    expect(selectedText()).toContain('plan.md');
  });

  it('selects on click and imports only through the primary action', () => {
    render({ files: [file('plan.md'), file('notes.md')] });

    click(options()[1]);
    expect(props.onImport).not.toHaveBeenCalled();
    expect(selectedText()).toContain('notes.md');

    click(q('[data-testid="import-plan-primary"]'));
    expect(importedNames()).toEqual(['file:notes.md']);
  });

  it('imports the selection on Enter and on double-click', () => {
    render({ suggestions: [suggestion('a')], files: [file('plan.md')] });

    key(q('[data-testid="import-plan-input"]'), 'Enter');
    expect(importedNames()).toEqual(['suggestion:a']);

    click(options()[1], 'dblclick');
    expect(importedNames()).toEqual(['suggestion:a', 'file:plan.md']);
  });

  it('does nothing on Enter with nothing to select', () => {
    render({ query: 'zzz' });

    key(q('[data-testid="import-plan-input"]'), 'Enter');
    expect(props.onImport).not.toHaveBeenCalled();
    expect(q('[data-testid="import-plan-empty"]')?.textContent).toBe(
      'No matches.',
    );
  });

  it('explains Browse when there are no plan files at all', () => {
    render();

    expect(q('[data-testid="import-plan-empty"]')?.textContent).toBe(
      'No plan files found. Use Browse… to pick any file.',
    );
  });

  it('keeps rows, the primary button, and Enter inert while importing', () => {
    render({ files: [file('plan.md'), file('notes.md')], importing: true });

    // Rows stay focusable so Escape still reaches the dialog.
    expect(options()[0]?.hasAttribute('disabled')).toBe(false);
    expect(options()[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(
      q('[data-testid="import-plan-primary"]')?.hasAttribute('disabled'),
    ).toBe(true);
    key(q('[data-testid="import-plan-input"]'), 'Enter');
    click(options()[0], 'dblclick');
    click(options()[1]);
    expect(props.onImport).not.toHaveBeenCalled();
    expect(selectedText()).toContain('plan.md');
    key(options()[0] ?? null, 'Escape');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the search box when an import starts', () => {
    render({ files: [file('plan.md')] });
    const primary = q<HTMLButtonElement>('[data-testid="import-plan-primary"]');
    act(() => {
      primary?.focus();
    });
    expect(document.activeElement).toBe(primary);

    rerender({ importing: true });

    const input = q('[data-testid="import-plan-input"]');
    expect(document.activeElement).toBe(input);
    key(input, 'Escape');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes the selection to assistive tech from the search box', () => {
    render({ suggestions: [suggestion('a')], files: [file('plan.md')] });
    const input = q('[data-testid="import-plan-input"]');
    const listbox = q('[role="listbox"]');

    expect(input?.getAttribute('role')).toBe('combobox');
    expect(input?.getAttribute('aria-controls')).toBe(listbox?.id);
    expect(options().every((option) => option.tabIndex === -1)).toBe(true);
    const activeId = (): string | null | undefined =>
      input?.getAttribute('aria-activedescendant');
    expect(activeId() && document.getElementById(activeId() ?? '')).toBe(
      options()[0],
    );
    key(input, 'ArrowDown');
    expect(activeId() && document.getElementById(activeId() ?? '')).toBe(
      options()[1],
    );
  });

  it('ignores Enter while an IME composition is in progress', () => {
    render({ files: [file('plan.md')] });

    act(() => {
      q('[data-testid="import-plan-input"]')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(props.onImport).not.toHaveBeenCalled();
  });

  it('leaves arrow keys to an IME composition in progress', () => {
    render({ suggestions: [suggestion('a')], files: [file('plan.md')] });
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });

    act(() => {
      q('[data-testid="import-plan-input"]')?.dispatchEvent(event);
    });
    expect(selectedText()).toContain('a.md');
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves Escape to an IME composition in progress', () => {
    render({ files: [file('plan.md')] });

    act(() => {
      q('[data-testid="import-plan-input"]')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('moves across the group boundary with arrow keys without wrapping', () => {
    render({ suggestions: [suggestion('a')], files: [file('plan.md')] });
    const input = q('[data-testid="import-plan-input"]');

    key(input, 'ArrowUp');
    expect(selectedText()).toContain('a.md');
    key(input, 'ArrowDown');
    expect(selectedText()).toContain('plan.md');
    key(input, 'ArrowDown');
    expect(selectedText()).toContain('plan.md');
  });

  it('closes on Escape', () => {
    render({ files: [file('plan.md')] });

    key(q('[data-testid="import-plan-input"]'), 'Escape');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a tracked file instead of importing it again', () => {
    render({ files: [file('plan.md', { trackedPlanId: 'plan-9' })] });

    expect(q('[data-testid="import-plan-tracked-badge"]')?.textContent).toBe(
      'Tracked',
    );
    const primary = q('[data-testid="import-plan-primary"]');
    expect(primary?.textContent).toContain('Open plan');
    click(primary);
    key(q('[data-testid="import-plan-input"]'), 'Enter');
    expect(props.onOpenTracked).toHaveBeenCalledWith('plan-9');
    expect(props.onImport).not.toHaveBeenCalled();
    // Opening a tracked plan copies nothing, so no copy notice shows.
    expect(q('[data-testid="import-plan-copy-notice"]')).toBeNull();
    expect(q('[role="dialog"]')?.textContent).not.toContain('Saves a copy.');
  });

  it('hides a suggestion and lists hidden ones collapsed', () => {
    const hidden = suggestion('old');
    render({ suggestions: [suggestion('a')], hiddenSuggestions: [hidden] });

    click(q('[data-testid="import-plan-detected-dismiss-a"]'));
    expect(
      jest.mocked(props.onDismissSuggestion).mock.calls.map(([s]) => s.id),
    ).toEqual(['a']);
    const details = q<HTMLDetailsElement>(
      '[data-testid="import-plan-dismissed-section"]',
    );
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('1 hidden');

    click(q('[data-testid="import-plan-detected-import-old"]'));
    expect(props.onImport).toHaveBeenCalledWith({
      kind: 'suggestion',
      suggestion: hidden,
    });
  });

  describe('preview', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    async function settle(): Promise<void> {
      await act(async () => {
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('shows the derived title, benefits, and the copy notice', async () => {
      const loadPreview = jest.fn().mockResolvedValue('# Rollout plan\n\nBody');
      render({ files: [file('plan.md')], loadPreview });

      expect(q('[data-testid="import-plan-preview-title"]')).toBeNull();
      await settle();

      const title = q('[data-testid="import-plan-preview-title"]');
      expect(title?.textContent).toBe('Rollout plan');
      expect(title?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      const preview = q('[data-testid="import-plan-preview"]');
      expect(preview?.textContent).toContain('Review and comment on it');
      expect(preview?.textContent).toContain('Keep revisions as it changes');
      expect(preview?.textContent).toContain('Implement it or run a pipeline');
      expect(q('[data-testid="import-plan-copy-notice"]')?.textContent).toBe(
        "Saves a copy. Later edits to the file don't update the plan.",
      );
    });

    it('omits the title when the read fails', async () => {
      const loadPreview = jest.fn().mockRejectedValue(new Error('gone'));
      render({ files: [file('plan.md')], loadPreview });
      await settle();

      expect(q('[data-testid="import-plan-preview-title"]')).toBeNull();
      expect(q('[data-testid="import-plan-preview"]')?.textContent).toContain(
        'plan.md',
      );
      expect(q('[data-testid="import-plan-copy-notice"]')).not.toBeNull();
    });

    it('ignores a response for a row that is no longer selected', async () => {
      let resolveFirst: (value: string) => void = () => undefined;
      const loadPreview = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce('# Second');
      render({ files: [file('first.md'), file('second.md')], loadPreview });
      await settle();
      expect(loadPreview).toHaveBeenCalledTimes(1);

      click(options()[1]);
      await settle();
      await act(async () => {
        resolveFirst('# First');
        await Promise.resolve();
      });

      expect(q('[data-testid="import-plan-preview-title"]')?.textContent).toBe(
        'Second',
      );
    });

    it('reads only the row the selection stops on', async () => {
      const loadPreview = jest.fn(
        (item: ImportPlanPickerItem): Promise<string | null> =>
          Promise.resolve(`# ${item.kind}`),
      );
      render({
        files: [file('a.md'), file('b.md'), file('c.md')],
        loadPreview,
      });
      const input = q('[data-testid="import-plan-input"]');
      key(input, 'ArrowDown');
      key(input, 'ArrowDown');
      await settle();

      expect(loadPreview).toHaveBeenCalledTimes(1);
      const item = loadPreview.mock.calls[0]?.[0];
      expect(item?.kind === 'file' && item.file.filename).toBe('c.md');
    });
  });

  it('keeps the selection while the list refreshes', () => {
    render({ files: [file('a.md'), file('b.md')] });
    click(options()[1]);

    rerender({ files: [file('a.md'), file('b.md'), file('c.md')] });
    expect(selectedText()).toContain('b.md');
  });
});
