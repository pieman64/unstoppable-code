/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): workspace notes and prompts open in an editor modal and a
// viewer modal. `DialogModal` records its card, so the bodies and fields carry
// their own blocks. This pins that the viewer's rendered markdown and both
// editors' fields render inside blocked regions of the recorded card.
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

jest.mock('@/components/shared/panel-section', () => ({
  PanelSection: ({
    children,
    headerAction,
  }: {
    children: JSX.Element;
    headerAction?: JSX.Element;
  }): JSX.Element => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
}));

import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { WorkspaceMarkdownItemsSection } from '../WorkspaceMarkdownItemsSection';
import { expectBlockedInRecordedDialogCard } from '@/test-utils/replay';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const NOTE_BODY = 'Customer Acme renews on the first of March.';
const NOTE = {
  id: 'acme-note',
  title: 'Acme renewal',
  absolutePath: '/data/ws/notes/acme-note.md',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

/** The editor's title field. The section itself renders no inputs. */
function titleField(): HTMLInputElement {
  const field = document.querySelector('input');
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('Editor title field not rendered');
  }
  return field;
}

/** The editor's content field. The section itself renders no textareas. */
function contentField(): HTMLTextAreaElement {
  const field = document.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('Editor content field not rendered');
  }
  return field;
}

describe('WorkspaceMarkdownItemsSection session replay', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialState = useWorkspaceItemsStore.getState();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useWorkspaceItemsStore.setState({
      notes: { 'project-1': [NOTE] },
      loadNotes: jest.fn(() => Promise.resolve()),
      readNote: jest.fn(() =>
        Promise.resolve({ meta: NOTE, content: NOTE_BODY }),
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useWorkspaceItemsStore.setState(initialState, true);
  });

  it('blocks the viewer markdown and the edit content field inside the recorded DialogModal card', async () => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(
          '[data-testid="workspace-notes-item"] [role="button"]',
        )
        ?.click();
      await Promise.resolve();
    });

    const body = Array.from(document.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent === NOTE_BODY,
    );
    if (body === undefined) throw new Error('Viewer body not rendered');
    expect(container.contains(body)).toBe(false);
    const viewer = expectBlockedInRecordedDialogCard(body);
    const heading = viewer.querySelector('h2');
    expect(heading?.textContent).toBe(NOTE.title);

    const edit = Array.from(viewer.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit',
    );
    if (edit === undefined) throw new Error('Edit control not rendered');
    act(() => edit.click());

    const title = titleField();
    const content = contentField();
    expect(title.value).toBe(NOTE.title);
    expect(content.value).toBe(NOTE_BODY);
    expect(container.contains(content)).toBe(false);
    // The title input is recorded (the recorder masks input values); the
    // markdown content field is item content and carries its own block.
    expect(title.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(title.closest('[role="dialog"]')).toBe(
      expectBlockedInRecordedDialogCard(content),
    );
  });

  it('blocks the new-item content field inside the recorded DialogModal card', () => {
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Add note"]')
        ?.click();
    });

    const title = titleField();
    const content = contentField();
    expect(container.contains(content)).toBe(false);
    expect(title.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(title.closest('[role="dialog"]')).toBe(
      expectBlockedInRecordedDialogCard(content),
    );
  });
});
