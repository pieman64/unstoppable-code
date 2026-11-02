/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LedgerFilePicker } from '@canopy/app-core';
import type { LedgerViewDraft } from '@canopy/app-state';
import type {
  LedgerViewFileCandidate,
  LedgerTaskViewScope,
} from '@canopy/protocol/ledger-view';
import { LedgerDraftFileSearch } from '../LedgerDraftFields';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const PARSER_TASK: LedgerTaskViewScope = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
};
const NOTES_TASK: LedgerTaskViewScope = {
  projectId: 'project-1',
  worktreeId: 'wt-2',
};
const DRAFT: LedgerViewDraft = {
  type: 'TASK',
  title: 'Ship it',
  content: '',
  highlights: [],
  referenceFiles: [],
  status: 'TODO',
  owner: null,
  supersedes: null,
};

function file(path: string): LedgerViewFileCandidate {
  return { rootId: 'repo-1', rootName: 'canopy', path };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(250);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

function resultPaths(): string[] {
  return Array.from(
    container.querySelectorAll('[data-testid="ledger-file-search-result"]'),
    (result) => result.querySelector('span')?.textContent ?? '',
  );
}

describe('LedgerDraftFileSearch', () => {
  it('never offers the files of a task the draft has left', async () => {
    let answerNotes: (files: readonly LedgerViewFileCandidate[]) => void = () =>
      undefined;
    const files: LedgerFilePicker = {
      searchFiles: (scope) =>
        scope.worktreeId === PARSER_TASK.worktreeId
          ? Promise.resolve([file('src/parser.ts')])
          : new Promise((resolve) => {
              answerNotes = resolve;
            }),
    };
    const onChange = jest.fn();
    const render = (scope: LedgerTaskViewScope): void => {
      act(() =>
        root.render(
          <LedgerDraftFileSearch
            files={files}
            scope={scope}
            draft={DRAFT}
            saving={false}
            onChange={onChange}
          />,
        ),
      );
    };
    render(PARSER_TASK);
    const input = container.querySelector('input');
    if (input === null) throw new Error('Missing the file search');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'src');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(resultPaths()).toEqual(['src/parser.ts']);

    // The draft moves to another task: its search starts over there, and the
    // first task's files are gone at once.
    render(NOTES_TASK);
    expect(resultPaths()).toEqual([]);
    expect(container.textContent).toContain('Searching…');

    await settle();
    await act(async () => {
      answerNotes([file('docs/notes.md')]);
      await Promise.resolve();
    });
    expect(resultPaths()).toEqual(['docs/notes.md']);
  });
});
