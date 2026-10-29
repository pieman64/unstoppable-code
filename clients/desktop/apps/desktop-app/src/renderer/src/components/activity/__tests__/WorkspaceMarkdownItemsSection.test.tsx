/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/components/shared/panel-section', () => ({
  PanelSection: ({
    children,
    headerAction,
    icon,
  }: {
    children: JSX.Element;
    headerAction?: JSX.Element;
    icon?: JSX.Element;
  }): JSX.Element => (
    <section>
      <span data-testid="panel-section-icon">{icon}</span>
      {headerAction}
      {children}
    </section>
  ),
}));

jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: ({ children }: { children: JSX.Element }): JSX.Element => (
    <div role="dialog">{children}</div>
  ),
}));

import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { NotesSection } from '../NotesSection';
import { PromptsSection } from '../PromptsSection';
import { WorkspaceMarkdownItemsSection } from '../WorkspaceMarkdownItemsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('WorkspaceMarkdownItemsSection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialState = useWorkspaceItemsStore.getState();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useWorkspaceItemsStore.setState(initialState, true);
  });

  it('records the section and its item titles in session replay', () => {
    useWorkspaceItemsStore.setState({
      loadNotes: jest.fn((): Promise<void> => Promise.resolve()),
      notes: {
        'project-1': [
          {
            id: 'note-1',
            title: 'Release checklist',
            absolutePath: '/repo/.canopy/notes/note-1.md',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    act(() => {
      root.render(
        <WorkspaceMarkdownItemsSection
          projectId="project-1"
          worktreeId="worktree-1"
          kind="note"
          title="Notes"
          icon={<span />}
          noun="note"
          mentionRepoName="Notes"
          testIdPrefix="workspace-notes"
        />,
      );
    });

    // Item titles are recorded: neither the section nor the list body
    // carries a replay block.
    const title = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Release checklist',
    );
    expect(title).toBeDefined();
    expect(title?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('uses the medium plus glyph for the add action', () => {
    act(() => {
      root.render(
        <WorkspaceMarkdownItemsSection
          projectId="project-1"
          worktreeId="worktree-1"
          kind="note"
          title="Notes"
          icon={<span />}
          noun="note"
          mentionRepoName="Notes"
          testIdPrefix="workspace-notes"
        />,
      );
    });

    const addButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Add note"]',
    );
    expect(addButton?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      'plus',
    );
  });

  it('renders the Prompts card with the edit glyph, not a terminal prompt', () => {
    act(() => {
      root.render(<PromptsSection projectId="project-1" worktreeId="wt-1" />);
    });

    const iconSlot = container.querySelector(
      '[data-testid="panel-section-icon"]',
    );
    const icon = iconSlot?.querySelector('svg');
    // The hand-rolled `>_` icon was a chevron polyline plus an underscore line.
    expect(iconSlot?.querySelector('polyline')).toBeNull();
    expect(icon?.getAttribute('data-app-icon')).toBe('true');
    expect(icon?.getAttribute('data-glyph')).toBe('square-pen');
  });

  it('renders the Notes card with the note-text glyph', () => {
    act(() => {
      root.render(<NotesSection projectId="project-1" worktreeId="wt-1" />);
    });

    const iconSlot = container.querySelector(
      '[data-testid="panel-section-icon"]',
    );
    const icon = iconSlot?.querySelector('svg');
    expect(icon?.getAttribute('data-app-icon')).toBe('true');
    expect(icon?.getAttribute('data-glyph')).toBe('sticky-note');
  });

  it('keeps a failed save draft open and reports the error', async () => {
    const saveNote = jest.fn(() => Promise.resolve(null));
    useWorkspaceItemsStore.setState({
      notes: { 'project-1': [] },
      loadNotes: jest.fn(() => Promise.resolve()),
      saveNote,
    });

    act(() => {
      root.render(
        <WorkspaceMarkdownItemsSection
          projectId="project-1"
          worktreeId="worktree-1"
          kind="note"
          title="Notes"
          icon={<span />}
          noun="note"
          mentionRepoName="Notes"
          testIdPrefix="workspace-notes"
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Add note"]')
        ?.click();
    });
    const title = container.querySelector<HTMLInputElement>('input');
    const content = container.querySelector<HTMLTextAreaElement>('textarea');
    if (title === null || content === null) {
      throw new Error('Editor controls not found');
    }
    act(() => {
      setControlValue(title, 'Draft title');
      setControlValue(content, 'Draft body');
    });

    await act(async () => {
      const save = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Save',
      );
      save?.click();
      await Promise.resolve();
    });

    expect(saveNote).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Draft title',
      content: 'Draft body',
      originWorktreeId: 'worktree-1',
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Unable to save this note. Your draft is still open.',
    );
    expect(title.value).toBe('Draft title');
    expect(content.value).toBe('Draft body');
  });

  it('does not render remote markdown images', async () => {
    const item = {
      id: 'tracking-note',
      title: 'Tracking note',
      absolutePath: '/data/ws/notes/tracking-note.md',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    };
    useWorkspaceItemsStore.setState({
      notes: { 'project-1': [item] },
      loadNotes: jest.fn(() => Promise.resolve()),
      readNote: jest.fn(() =>
        Promise.resolve({
          meta: item,
          content: '![tracker](https://example.com/tracker.png)',
        }),
      ),
    });

    act(() => {
      root.render(
        <WorkspaceMarkdownItemsSection
          projectId="project-1"
          worktreeId="worktree-1"
          kind="note"
          title="Notes"
          icon={<span />}
          noun="note"
          mentionRepoName="Notes"
          testIdPrefix="workspace-notes"
        />,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="workspace-notes-item"] [role="button"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'tracker',
    );
  });
  // Shared-container recipients see the publisher's notes and prompts from
  // the replica, keyed per share, with nothing that adds, edits, deletes or
  // mentions them.
  it('lists a read-only scope per share without write or mention controls', () => {
    const loadNotes = jest.fn((): Promise<void> => Promise.resolve());
    useWorkspaceItemsStore.setState({
      loadNotes,
      notes: {
        'shared-container-viewer/container-a': [
          {
            id: 'note-1',
            title: 'Publisher note',
            absolutePath: '/replica/content/notes/note-1.md',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        'shared-container-viewer': [],
      },
    });

    act(() => {
      root.render(
        <WorkspaceAccessContext.Provider
          value={{
            mode: 'read-only',
            reason: 'shared-container',
            containerType: 'CODE_WORKTREE',
            runAllowed: false,
          }}
        >
          <WorkspaceMarkdownItemsSection
            projectId="shared-container-viewer"
            worktreeId="container-a"
            kind="note"
            title="Notes"
            icon={<span />}
            noun="note"
            mentionRepoName="Notes"
            testIdPrefix="workspace-notes"
          />
        </WorkspaceAccessContext.Provider>,
      );
    });

    expect(loadNotes).toHaveBeenCalledWith(
      'shared-container-viewer',
      'container-a',
    );
    expect(container.textContent).toContain('Publisher note');
    expect(container.querySelector('[aria-label="Add note"]')).toBeNull();
    expect(container.querySelector('[aria-label="Delete note"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Mention in chat"]'),
    ).toBeNull();
  });
});
