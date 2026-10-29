/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { EmbeddedDiffFileTree } from '../EmbeddedDiffFileTree';
import { rootClassList } from '@/test-utils/replay';

jest.mock('@/stores/fileTabUiStore', () => ({
  useFileTabUiStore: <T,>(
    selector: (state: {
      fileTreeListViewByTabId: Record<string, boolean>;
      setFileTreeListView: () => void;
    }) => T,
  ): T =>
    selector({ fileTreeListViewByTabId: {}, setFileTreeListView: () => {} }),
}));
jest.mock('@/stores/chatStore', () => ({
  // No chat tab is open, so there is no file-diff context.
  useChatTabRenderState: (): undefined => undefined,
}));
jest.mock('@/stores/activityStore', () => ({
  useActivityStore: <T,>(
    selector: (state: {
      changedFiles: Record<
        string,
        {
          uncommitted: {
            path: string;
            status: 'modified';
            insertions: number;
            deletions: number;
          }[];
          committed: never[];
        }
      >;
    }) => T,
  ): T =>
    selector({
      changedFiles: {
        'project-1/worktree-1': {
          uncommitted: [
            {
              path: 'src/secret.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
          committed: [],
        },
      },
    }),
}));
jest.mock('../../chat/useOpenFileDiffTarget', () => ({
  useOpenFileDiffTarget: (): null => null,
}));
jest.mock('../ChangedFilesSection', () => ({
  useChangedFilesSectionHostModel: (): Record<string, unknown> => ({
    changedFiles: {
      uncommitted: [{ filePath: 'src/secret.ts', repoId: undefined }],
      committed: [],
    },
  }),
  toPortalFile: (file: { path: string }): { filePath: string } => ({
    filePath: file.path,
  }),
}));
jest.mock('../DiffFileTree', () => ({
  DiffFileTree: (): JSX.Element => <div data-testid="mock-diff-file-tree" />,
}));
jest.mock('../EmbeddedFileTreeToolbar', () => ({
  EmbeddedFileTreeToolbar: (): null => null,
}));

describe('EmbeddedDiffFileTree', () => {
  it('records the embedded diff tree in session replay', (): void => {
    const markup = renderToStaticMarkup(
      <EmbeddedDiffFileTree
        projectId="project-1"
        worktreeId="worktree-1"
        tabId="tab-1"
        currentFilePath="src/secret.ts"
        onModeChange={jest.fn()}
      />,
    );

    expect(markup).not.toContain(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(rootClassList(markup)).toEqual([
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
    ]);
    expect(markup).toContain('data-testid="file-tab-diff-tree"');
    expect(markup).toContain('data-testid="mock-diff-file-tree"');
  });
});
