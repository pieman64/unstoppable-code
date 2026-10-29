/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MonacoFileDiff } from '../MonacoFileDiff';
import type { FileDiffSnapshot } from '../useFileDiffSnapshot';
import { rootClassList } from '@/test-utils/replay';

jest.mock('@monaco-editor/react', () => ({
  DiffEditor: (): JSX.Element => <div data-testid="diff-editor" />,
}));
jest.mock('monaco-editor', () => ({}), { virtual: true });
jest.mock('@/lib/monaco-setup', () => ({
  configureMonaco: (): void => {},
}));

const snapshot: FileDiffSnapshot = {
  data: {
    oldValue: 'const secret = 1;',
    newValue: 'const secret = 2;',
    filePath: 'src/secret.ts',
    source: 'uncommitted',
    truncated: true,
    binary: false,
  },
  identity: { source: 'uncommitted', snapshotId: 'snapshot-1' },
};

describe('MonacoFileDiff', () => {
  it('blocks the diff editor root from session replay', (): void => {
    const markup = renderToStaticMarkup(
      <MonacoFileDiff
        split={false}
        onSplitChange={jest.fn()}
        tabId="tab-1"
        filePath="src/secret.ts"
        snapshot={snapshot}
        threads={[]}
        annotations={[]}
        onOpenLine={jest.fn()}
        onComment={jest.fn()}
        viewState={{ current: { split: false } }}
      />,
    );

    expect(rootClassList(markup)).toEqual([
      POSTHOG_REPLAY_BLOCK_CLASS,
      'canopy-monaco-file-editor',
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
    ]);
    expect(markup).toContain('data-testid="diff-editor"');
  });

  it('marks a cut diff with the shared notice the web shows (REG-3024)', (): void => {
    const markup = renderToStaticMarkup(
      <MonacoFileDiff
        split={false}
        onSplitChange={jest.fn()}
        tabId="tab-1"
        filePath="src/secret.ts"
        snapshot={snapshot}
        threads={[]}
        annotations={[]}
        onOpenLine={jest.fn()}
        onComment={jest.fn()}
        viewState={{ current: { split: false } }}
      />,
    );

    expect(markup).toContain('data-testid="diff-viewer-notice-oversized"');
    expect(markup).toContain(
      'This diff is too large to show in full. Showing the beginning.',
    );
    expect(markup).not.toContain('Diff truncated');
    expect(markup).not.toContain('fg-warning');
  });
});
