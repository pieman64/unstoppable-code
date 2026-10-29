import * as shared from '@canopy/app-core';
import * as desktop from '../editorSelectionContext';
import {
  appendSelectionContextBlocks,
  appendSelectionToList,
  computeSelectionFreshness,
  consumePendingEditorRangeReveal,
  formatSelectionLabel,
  isDuplicateSelection,
  peekPendingEditorRangeReveal,
  resolveSelectionTargetTabId,
  shouldHandleChatTextInsertion,
  stashPendingEditorRangeReveal,
  type EditorSelectionContext,
} from '../editorSelectionContext';

function buildDetail(
  overrides: Partial<Omit<EditorSelectionContext, 'id'>> = {},
): Omit<EditorSelectionContext, 'id'> {
  return {
    projectId: 'proj',
    worktreeId: 'wt',
    absolutePath: '/repo/src/App.tsx',
    displayPath: 'src/App.tsx',
    startLine: 2,
    startColumn: 1,
    endLine: 3,
    endColumn: 13,
    text: 'const b = 2;\nconst c = 3;',
    language: 'typescript',
    capturedDirty: false,
    ...overrides,
  };
}

function buildSelection(
  overrides: Partial<EditorSelectionContext> = {},
): EditorSelectionContext {
  const { id = 'sel-1', ...detailOverrides } = overrides;
  return { id, ...buildDetail(detailOverrides) };
}

const FILE_CONTENT = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n';

describe('formatSelectionLabel', () => {
  it('shows filename with a line range for multi-line selections', () => {
    expect(formatSelectionLabel(buildSelection())).toBe('App.tsx:2-3');
  });

  it('shows a single line number when the selection stays on one line', () => {
    expect(
      formatSelectionLabel(buildSelection({ startLine: 5, endLine: 5 })),
    ).toBe('App.tsx:5');
  });

  it('excludes an empty final line at Monaco exclusive column 1', () => {
    expect(
      formatSelectionLabel(
        buildSelection({ startLine: 2, endLine: 3, endColumn: 1 }),
      ),
    ).toBe('App.tsx:2');
  });
});

describe('computeSelectionFreshness', () => {
  it('reports fresh when the captured range still matches the content', () => {
    expect(computeSelectionFreshness(buildSelection(), FILE_CONTENT)).toBe(
      'fresh',
    );
  });

  it('reports fresh for a partial-line selection at its captured columns', () => {
    const selection = buildSelection({
      startLine: 2,
      startColumn: 7,
      endLine: 2,
      endColumn: 12,
      text: 'b = 2',
    });
    expect(computeSelectionFreshness(selection, FILE_CONTENT)).toBe('fresh');
  });

  it('reports fresh when current file content uses CRLF line endings', () => {
    expect(
      computeSelectionFreshness(
        buildSelection(),
        FILE_CONTENT.replace(/\n/g, '\r\n'),
      ),
    ).toBe('fresh');
  });

  it('preserves a literal carriage return at end of content', () => {
    const selection = buildSelection({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 7,
      text: 'alpha\r',
    });

    expect(computeSelectionFreshness(selection, 'alpha\r')).toBe('fresh');
  });

  it('compares the captured range without depending on trailing file content', () => {
    const selection = buildSelection({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 6,
      text: 'alpha',
    });
    const content = `alpha\n${'trailing content\n'.repeat(10_000)}`;

    expect(computeSelectionFreshness(selection, content)).toBe('fresh');
  });

  it('reports stale when only a duplicate outside the captured columns remains', () => {
    const selection = buildSelection({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 7,
      text: 'repeat',
    });
    expect(computeSelectionFreshness(selection, 'edited repeat\n')).toBe(
      'stale',
    );
  });

  it('reports stale when the captured text shifts within the same line', () => {
    const selection = buildSelection({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 7,
      text: 'repeat',
    });
    expect(computeSelectionFreshness(selection, 'xrepeat\n')).toBe('stale');
  });

  it('reports stale when a line in the captured range was edited', () => {
    const edited = FILE_CONTENT.replace('const b = 2;', 'const b = 99;');
    expect(computeSelectionFreshness(buildSelection(), edited)).toBe('stale');
  });

  it('reports stale when the file no longer reaches the captured range', () => {
    expect(computeSelectionFreshness(buildSelection(), 'const a = 1;')).toBe(
      'stale',
    );
  });

  it('reports missing when the content is unavailable', () => {
    expect(computeSelectionFreshness(buildSelection(), null)).toBe('missing');
  });
});

describe('appendSelectionContextBlocks', () => {
  it('returns the text unchanged when there are no selections', () => {
    expect(appendSelectionContextBlocks('fix this', [])).toBe('fix this');
  });

  it('appends a structured block with file, lines, and language', () => {
    const result = appendSelectionContextBlocks('fix this', [
      { selection: buildSelection(), freshness: 'fresh' },
    ]);
    expect(result).toBe(
      'fix this\n\n' +
        '<code_selection file="src/App.tsx" lines="2-3" language="typescript">\n' +
        'const b = 2;\nconst c = 3;\n' +
        '</code_selection>',
    );
  });

  it('serializes inclusive line metadata for an exclusive column-1 endpoint', () => {
    const result = appendSelectionContextBlocks('fix this', [
      {
        selection: buildSelection({
          startLine: 2,
          endLine: 4,
          endColumn: 1,
        }),
        freshness: 'fresh',
      },
    ]);
    expect(result).toContain('lines="2-3"');
  });

  it('marks stale and unsaved selections in the block attributes', () => {
    const result = appendSelectionContextBlocks('fix this', [
      {
        selection: buildSelection({ capturedDirty: true }),
        freshness: 'stale',
      },
    ]);
    expect(result).toContain(
      '<code_selection file="src/App.tsx" lines="2-3" language="typescript" unsaved="true" status="stale">',
    );
  });

  it('marks selections whose freshness check is still pending', () => {
    const result = appendSelectionContextBlocks('fix this', [
      { selection: buildSelection(), freshness: 'checking' },
    ]);
    expect(result).toContain('status="checking"');
  });

  it('includes the repo id when the selection carries one', () => {
    const result = appendSelectionContextBlocks('fix this', [
      {
        selection: buildSelection({ repoId: 'backend' }),
        freshness: 'fresh',
      },
    ]);
    expect(result).toContain(
      '<code_selection file="src/App.tsx" repo="backend" lines="2-3" language="typescript">',
    );
  });

  it('escapes metadata that could break selection block attributes', () => {
    const result = appendSelectionContextBlocks('fix this', [
      {
        selection: buildSelection({
          displayPath: 'src/<App & "admin">.tsx',
          repoId: "front'end",
          language: 'type"script',
        }),
        freshness: 'fresh',
      },
    ]);
    expect(result).toContain(
      'file="src/&lt;App &amp; &quot;admin&quot;&gt;.tsx"',
    );
    expect(result).toContain('repo="front&apos;end"');
    expect(result).toContain('language="type&quot;script"');
  });

  it('escapes text that could terminate a selection block early', () => {
    const result = appendSelectionContextBlocks('fix this', [
      {
        selection: buildSelection({
          text: 'before </code_selection> & after',
        }),
        freshness: 'fresh',
      },
    ]);
    expect(result).toContain(
      'before &lt;/code_selection&gt; &amp; after\n</code_selection>',
    );
    expect(result.match(/<\/code_selection>/g)).toHaveLength(1);
  });

  it('appends multiple selections as separate blocks', () => {
    const result = appendSelectionContextBlocks('fix this', [
      { selection: buildSelection(), freshness: 'fresh' },
      {
        selection: buildSelection({
          id: 'sel-2',
          displayPath: 'src/util.ts',
          startLine: 10,
          endLine: 10,
          text: 'export {};',
          language: 'typescript',
        }),
        freshness: 'fresh',
      },
    ]);
    const occurrences = result.match(/<code_selection /g);
    expect(occurrences).toHaveLength(2);
    expect(result).toContain('file="src/util.ts" lines="10"');
  });
});

describe('appendSelectionToList', () => {
  it('appends a new selection with a generated id', () => {
    const detail = buildDetail();
    const next = appendSelectionToList(undefined, detail);
    expect(next).toHaveLength(1);
    expect(next[0].id).toEqual(expect.any(String));
    expect(next[0].text).toBe(detail.text);
  });

  it('returns the original list when the selection is a duplicate', () => {
    const existing = [buildSelection()];
    expect(appendSelectionToList(existing, buildDetail())).toBe(existing);
  });

  it('generates unique ids for successive selections', () => {
    const detail = buildDetail();
    const first = appendSelectionToList(undefined, detail);
    const second = appendSelectionToList(first, {
      ...detail,
      startLine: 10,
      endLine: 12,
    });
    expect(second).toHaveLength(2);
    expect(second[0].id).not.toBe(second[1].id);
  });
});

describe('pending editor range reveals', () => {
  const detail = {
    absolutePath: '/repo/src/App.tsx',
    startLine: 2,
    startColumn: 1,
    endLine: 3,
    endColumn: 14,
  };

  it('peek returns the stashed reveal without consuming it', () => {
    stashPendingEditorRangeReveal(detail);
    expect(peekPendingEditorRangeReveal('/repo/src/App.tsx')).toEqual(detail);
    expect(peekPendingEditorRangeReveal('/repo/src/App.tsx')).toEqual(detail);
    consumePendingEditorRangeReveal('/repo/src/App.tsx');
  });

  it('consume returns the stashed reveal exactly once', () => {
    stashPendingEditorRangeReveal(detail);
    expect(consumePendingEditorRangeReveal('/repo/src/App.tsx')).toEqual(
      detail,
    );
    expect(consumePendingEditorRangeReveal('/repo/src/App.tsx')).toBeNull();
  });

  it('returns null for a path with no stashed reveal', () => {
    expect(peekPendingEditorRangeReveal('/repo/other.ts')).toBeNull();
    expect(consumePendingEditorRangeReveal('/repo/other.ts')).toBeNull();
  });

  it('a later stash for the same path replaces the earlier one', () => {
    stashPendingEditorRangeReveal(detail);
    stashPendingEditorRangeReveal({ ...detail, startLine: 9, endLine: 9 });
    expect(consumePendingEditorRangeReveal('/repo/src/App.tsx')).toMatchObject({
      startLine: 9,
    });
  });
});

describe('resolveSelectionTargetTabId', () => {
  const chatA = { id: 'chat-a' };
  const chatB = { id: 'chat-b' };
  const fileTab = { id: 'file-1', kind: 'file' };
  const readOnlyTab = { id: 'chat-ro', readOnly: true };

  it('prefers the active tab when it is an editable chat tab', () => {
    expect(
      resolveSelectionTargetTabId({
        tabs: [chatA, chatB, fileTab],
        activeTabId: 'chat-b',
        lastActiveEditableChatId: 'chat-a',
      }),
    ).toBe('chat-b');
  });

  it('uses the remembered editable chat while a file tab is active', () => {
    expect(
      resolveSelectionTargetTabId({
        tabs: [chatA, chatB, fileTab],
        activeTabId: 'file-1',
        lastActiveEditableChatId: 'chat-b',
      }),
    ).toBe('chat-b');
  });

  it('falls back to the first editable chat tab when nothing is remembered', () => {
    // Legacy persisted files predate lastActiveEditableChatId; capture must
    // still land somewhere deterministic instead of silently failing.
    expect(
      resolveSelectionTargetTabId({
        tabs: [fileTab, chatA, chatB],
        activeTabId: 'file-1',
      }),
    ).toBe('chat-a');
  });

  it('falls back when the remembered id no longer resolves to an editable tab', () => {
    expect(
      resolveSelectionTargetTabId({
        tabs: [fileTab, readOnlyTab, chatB],
        activeTabId: 'file-1',
        lastActiveEditableChatId: 'chat-ro',
      }),
    ).toBe('chat-b');
  });

  it('returns null only when no editable chat tab exists at all', () => {
    expect(
      resolveSelectionTargetTabId({
        tabs: [fileTab, readOnlyTab],
        activeTabId: 'file-1',
      }),
    ).toBeNull();
  });
});

describe('shouldHandleChatTextInsertion', () => {
  it('routes targeted file text to its tab even when that composer is hidden', () => {
    expect(
      shouldHandleChatTextInsertion(
        { text: 'selected', targetTabId: 'chat-a' },
        'chat-a',
        false,
      ),
    ).toBe(true);
  });

  it('does not fan targeted file text out to other mounted composers', () => {
    expect(
      shouldHandleChatTextInsertion(
        { text: 'selected', targetTabId: 'chat-a' },
        'chat-b',
        true,
      ),
    ).toBe(false);
  });

  it('keeps untargeted terminal text scoped to the visible composer', () => {
    expect(
      shouldHandleChatTextInsertion({ text: 'terminal' }, 'chat-a', true),
    ).toBe(true);
    expect(
      shouldHandleChatTextInsertion({ text: 'terminal' }, 'chat-a', false),
    ).toBe(false);
  });

  it('never routes insertion text into a queued-message editor', () => {
    expect(
      shouldHandleChatTextInsertion(
        { text: 'selected', targetTabId: 'chat-a' },
        'chat-a',
        true,
        true,
      ),
    ).toBe(false);
  });
});

describe('isDuplicateSelection', () => {
  it('detects an identical range in the same file', () => {
    expect(
      isDuplicateSelection([buildSelection()], buildSelection({ id: 'other' })),
    ).toBe(true);
  });

  it('allows the same range with different text (edited since)', () => {
    expect(
      isDuplicateSelection(
        [buildSelection()],
        buildSelection({ id: 'other', text: 'changed' }),
      ),
    ).toBe(false);
  });

  it('allows a different range in the same file', () => {
    expect(
      isDuplicateSelection(
        [buildSelection()],
        buildSelection({ id: 'other', startLine: 7, endLine: 9 }),
      ),
    ).toBe(false);
  });
});

it('re-exports the shared chat insertion contract and rejects invalid chat targets', () => {
  expect(desktop.INSERT_CHAT_TEXT_EVENT).toBe(shared.INSERT_CHAT_TEXT_EVENT);
  expect(desktop.isInsertChatTextDetail).toBe(shared.isInsertChatTextDetail);
  expect(
    shared.isInsertChatTextDetail({ text: 'output', targetChatId: 'chat-1' }),
  ).toBe(true);
  expect(
    shared.isInsertChatTextDetail({ text: 'output', targetChatId: 42 }),
  ).toBe(false);
});
