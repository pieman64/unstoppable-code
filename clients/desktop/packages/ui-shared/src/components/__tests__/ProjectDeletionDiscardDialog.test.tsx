/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';
import {
  PROJECT_DELETION_DISCARD_DIALOG_TEST_ID,
  ProjectDeletionDiscardDialog,
  type ProjectDeletionDiscardDialogProps,
} from '../ProjectDeletionDiscardDialog';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function description(
  id: string,
  extra: Partial<WorktreeDiscardDescription> = {},
): WorktreeDiscardDescription {
  return {
    version: 1,
    workspaceId: 'ws',
    worktreeId: id,
    createdAt: '2026-10-30T00:00:00.000Z',
    status: 'discardable',
    causes: ['pending-checkout-quarantine'],
    sources: [],
    targets: [
      {
        kind: 'git-quarantine',
        path: `/data/ws/worktrees/.${id}.archive-quarantine`,
        identity: '1:3',
        identityVerified: false,
        reason: 'pending-checkout-quarantine',
      },
    ],
    alsoDeleted: ['chats', 'cost-history'],
    preserved: ['source-working-files', 'branches'],
    mayRemain: [],
    confirmation: 'token',
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(props: Partial<ProjectDeletionDiscardDialogProps>): string {
  act(() => {
    root.render(
      <ProjectDeletionDiscardDialog
        projectName="Garden"
        items={[]}
        interruptedDeletion={false}
        earlierDiscarded={[]}
        busy={false}
        errorMessage={null}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        {...props}
      />,
    );
  });
  return (
    document.querySelector(
      `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}"]`,
    )?.textContent ?? ''
  );
}

describe('ProjectDeletionDiscardDialog (CAN-5337)', () => {
  it('names each worktree with its paths and progress, masks the names, and omits the branch promise', () => {
    const text = render({
      items: [
        {
          worktreeId: 'one',
          worktreeName: 'owl',
          description: description('one'),
          progress: 'discarded',
        },
        {
          worktreeId: 'two',
          description: description('two', { targets: [] }),
          progress: 'discarding',
        },
      ],
    });
    expect(text).toContain('Delete project “Garden”?');
    expect(text).toContain('owl');
    expect(text).toContain('Discarded');
    expect(text).toContain('/data/ws/worktrees/.one.archive-quarantine');
    // A row-absent interrupted discard shows its id.
    expect(text).toContain('two');
    expect(text).toContain('Discarding…');
    expect(text).toContain('Its folders are already gone.');
    expect(text).toContain('Their chats and cost history are deleted too.');
    expect(text).toContain('may hold the only copy');
    expect(text).not.toContain('Branches');
    const names = Array.from(
      document.querySelectorAll(
        `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-item"] .${REPLAY_MASK_CLASS}`,
      ),
      (element) => element.textContent,
    );
    expect(names).toEqual(['owl', 'two']);
    expect(
      document.querySelector(
        `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-confirm"]`,
      )?.textContent,
    ).toContain('Discard worktrees and delete project');
  });

  it('says an interrupted deletion is replaced, and names earlier discards as final', () => {
    const text = render({
      items: [
        {
          worktreeId: 'one',
          worktreeName: 'owl',
          description: description('one'),
          progress: 'pending',
        },
      ],
      interruptedDeletion: true,
      earlierDiscarded: ['lark'],
    });
    expect(text).toContain(
      'An earlier deletion of this project was interrupted. Deleting it again replaces that attempt.',
    );
    expect(text).toContain('Already discarded, which is final: lark');
    expect(
      document.querySelector(
        `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-earlier"] .${REPLAY_MASK_CLASS}`,
      )?.textContent,
    ).toBe('lark');
  });

  it('offers each unfinished row its own discard while more than one is unfinished, and none while the run is going', () => {
    const onDiscardItem = jest.fn();
    const rowButtons = (): HTMLButtonElement[] =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-item-discard"]`,
        ),
      );
    const items: ProjectDeletionDiscardDialogProps['items'] = [
      {
        worktreeId: 'one',
        worktreeName: 'owl',
        description: description('one'),
        progress: 'discarded',
      },
      {
        worktreeId: 'two',
        worktreeName: 'lark',
        description: description('two'),
        progress: 'pending',
      },
      {
        worktreeId: 'three',
        worktreeName: 'wren',
        description: description('three'),
        progress: 'stopped',
      },
    ];
    render({ items, onDiscardItem });
    expect(rowButtons().map((button) => button.textContent)).toEqual([
      'Discard',
      'Discard',
    ]);
    act(() => rowButtons()[1].click());
    expect(onDiscardItem).toHaveBeenCalledWith('three');

    render({ items, onDiscardItem, busy: true });
    expect(rowButtons().every((button) => button.disabled)).toBe(true);

    // With one left, the dialog's own action is that item's discard, and it
    // says it also deletes the project.
    render({ items: items.slice(1, 2), onDiscardItem });
    expect(rowButtons()).toEqual([]);
    render({ items: items.slice(0, 2), onDiscardItem });
    expect(rowButtons()).toEqual([]);
  });

  it('with only an interrupted deletion, offers the deletion alone', () => {
    const text = render({ interruptedDeletion: true });
    expect(text).toContain(
      'An earlier deletion of this project was interrupted.',
    );
    expect(text).not.toContain('disconnected drive');
    expect(
      document.querySelector(
        `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-confirm"]`,
      )?.textContent,
    ).toContain('Delete project');
  });
});
