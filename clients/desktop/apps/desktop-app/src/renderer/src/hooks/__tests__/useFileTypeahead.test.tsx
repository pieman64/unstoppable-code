/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, Transforms } from 'slate';
import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import {
  createChatEditor,
  createEmptyValue,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import type { UseFileTypeaheadResult } from '@canopy/ui-rich/plugins';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { useFileTypeahead } from '../useFileTypeahead';

// jsdom's test global scope does not expose Node's structuredClone; the
// shared editor helpers use it to build/clone Slate values.
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  });
}

interface HookProbe {
  current: UseFileTypeaheadResult | null;
}

function HookHarness({
  editor,
  repos,
  probe,
}: {
  editor: ChatEditor;
  repos: RepoFileIndex[];
  probe: HookProbe;
}): null {
  probe.current = useFileTypeahead(editor, repos, true);
  return null;
}

/** Types `@query` at the end of the editor and moves selection there. */
function typeTrigger(editor: ChatEditor, query: string): void {
  Transforms.insertText(editor, `@${query}`);
  const point = Editor.end(editor, []);
  Transforms.select(editor, { anchor: point, focus: point });
}

describe('useFileTypeahead (desktop wrapper)', () => {
  let container: HTMLDivElement;
  let root: Root;

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
  });

  /**
   * Task F3 pipeline-mode decision: `home:file-index` returns exactly one
   * root for `cowork` and `baseline` targets, while `worktree` targets on
   * multi-repo workspaces ARE multi-root (workspace root + child repos via
   * `buildFileIndexes`). Shadow paths only ever appear on the single-root
   * `baseline` index, which is what this test pins: with a single repo, the
   * inserted pill's `displayPath` is always the bare relative path — never
   * the repo's `absolutePath` (which, for a `baseline` target, is the
   * repo-shadow checkout path). Since `serializeEditorValue` inlines
   * `displayPath` verbatim into the message text, this guarantees pipeline
   * mode's synthesized task text (`buildPipelineTaskText` in `homeSend.ts`)
   * never leaks the shadow checkout's absolute path. (Multi-root worktree
   * targets can produce repoName-prefixed displayPaths, but those are still
   * relative paths into a REAL checkout — never shadow paths — so the
   * pipeline-text guarantee holds there too.) No separate rewrite is needed
   * for pipeline-mode text, only for the `FileReference.absolutePath`
   * carried through the chat-mode send path.
   */
  it('inserts a relative displayPath for a single-repo index, even when absolutePath is a repo-shadow checkout', () => {
    const shadowRepo: RepoFileIndex = {
      repoId: 'baseline',
      repoName: 'repo',
      absolutePath: '/data/repo-shadows/k/checkout',
      rootKind: 'git-repo',
      files: [
        {
          relativePath: 'src/main.ts',
          filename: 'main.ts',
          absolutePath: '/data/repo-shadows/k/checkout/src/main.ts',
          isIgnored: false,
        },
      ],
    };

    const editor = createChatEditor();
    editor.children = createEmptyValue();
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };

    const probe: HookProbe = { current: null };
    act(() => {
      root.render(
        <HookHarness editor={editor} repos={[shadowRepo]} probe={probe} />,
      );
    });

    act(() => {
      typeTrigger(editor, 'main');
    });
    act(() => {
      root.render(
        <HookHarness editor={editor} repos={[shadowRepo]} probe={probe} />,
      );
    });

    const file = probe.current?.filteredFiles[0];
    expect(file?.absolutePath).toBe(
      '/data/repo-shadows/k/checkout/src/main.ts',
    );

    act(() => {
      if (file) probe.current?.selectFile(file);
    });

    const serialized = serializeEditorValue(editor.children);
    expect(serialized.fileReferences).toEqual([
      {
        displayPath: 'src/main.ts',
        absolutePath: '/data/repo-shadows/k/checkout/src/main.ts',
        textStart: 0,
      },
    ]);
    expect(serialized.text).not.toContain('/data/repo-shadows');
    expect(serialized.text).toContain('src/main.ts');
  });
});
