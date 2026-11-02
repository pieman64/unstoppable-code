import type { ChatMessageEvent } from '@canopy/app-core';
import { persistedMessageToPortalMessage } from '@canopy/agent-transcript/portal/persisted-chat-projection';
import type {
  PortalChatMessage,
  PortalChatPart,
} from '@canopy/protocol/portal';
import {
  createAgentFileEditTracker,
  editPathMatchesRelativePath,
  extractAgentEditPaths,
  normalizeEditPath,
} from '../agent-file-edits';

function toolUse(
  toolUseId: string,
  toolName: string,
  input: string,
): PortalChatPart {
  return { kind: 'tool_use', data: { toolUseId, toolName, input } };
}

function toolResult(toolUseId: string, isError: unknown): PortalChatPart {
  return { kind: 'tool_result', data: { toolUseId, output: 'ok', isError } };
}

function event(
  parts: PortalChatPart[],
  overrides: Partial<ChatMessageEvent> = {},
  message: Partial<PortalChatMessage> = {},
): ChatMessageEvent {
  const chatId = overrides.chatId ?? 'chat-1';
  return {
    occurredAt: '2026-10-24T00:00:00.000Z',
    scope: 'worktree',
    workspaceLocalId: 'p1',
    worktreeLocalId: 'wt1',
    chatId,
    ...overrides,
    message: {
      messageId: 'm1',
      chatId,
      role: 'assistant',
      status: 'complete',
      text: '',
      parts,
      createdAtMs: 1_000,
      ...message,
    },
  };
}

const EDIT_INPUT = JSON.stringify({
  file_path: '/Users/r/Cowork/onboarding-findings.md',
  old_string: 'six',
  new_string: 'eight',
});

describe('extractAgentEditPaths', () => {
  it('reads file_path from structured Edit, MultiEdit and Write inputs', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write']) {
      expect(extractAgentEditPaths(tool, EDIT_INPUT)).toEqual([
        '/Users/r/Cowork/onboarding-findings.md',
      ]);
    }
    expect(
      extractAgentEditPaths(
        'NotebookEdit',
        JSON.stringify({ notebook_path: '/a/b.ipynb', new_source: 'x' }),
      ),
    ).toEqual(['/a/b.ipynb']);
  });

  it('recovers a complete top-level path from truncated JSON', () => {
    const truncated = `{"file_path":"/a/My Notes/caf\\u00e9.md","content":"# Findings\\n\\nSix participants`;
    expect(extractAgentEditPaths('Write', truncated)).toEqual([
      '/a/My Notes/café.md',
    ]);
  });

  it('never takes a file_path that appears inside document content', () => {
    const content = JSON.stringify({
      content: '{"file_path": "/evil.md"}',
      file_path: '/good.md',
    });
    expect(extractAgentEditPaths('Write', content)).toEqual(['/good.md']);
    // Truncated before the real top-level field: nothing is guessed.
    const truncated = '{"content":"{\\"file_path\\": \\"/evil.md\\"} and more';
    expect(extractAgentEditPaths('Write', truncated)).toEqual([]);
    // A truncated path value is incomplete and ignored.
    expect(extractAgentEditPaths('Edit', '{"file_path":"/a/onboard')).toEqual(
      [],
    );
  });

  it('ignores malformed inputs and unsupported tools', () => {
    expect(extractAgentEditPaths('Edit', 'not json')).toEqual([]);
    expect(extractAgentEditPaths('Edit', '{"file_path":42}')).toEqual([]);
    expect(extractAgentEditPaths('Read', EDIT_INPUT)).toEqual([]);
  });

  it('collects update, add, delete and move paths from patches', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Move to: src/b.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: docs/new.md',
      '+hello',
      '*** Delete File: docs/old.md',
      '*** End Patch',
    ].join('\n');
    const expected = ['src/a.ts', 'src/b.ts', 'docs/new.md', 'docs/old.md'];
    expect(extractAgentEditPaths('apply_patch', patch)).toEqual(expected);
    expect(
      extractAgentEditPaths(
        'functions.apply_patch',
        JSON.stringify({ input: patch }),
      ),
    ).toEqual(expected);
  });

  it('drops a cut-off final patch line', () => {
    const truncated =
      '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: docs/ne';
    expect(extractAgentEditPaths('apply_patch', truncated)).toEqual([
      'src/a.ts',
    ]);
    expect(
      extractAgentEditPaths('apply_patch', '{"input":"*** Update File: a'),
    ).toEqual([]);
  });

  it('reads Codex file_change summaries', () => {
    expect(
      extractAgentEditPaths(
        'file_change',
        'update: /w/notes.md\nadd: /w/new.md\ndelete: /w/old.md',
      ),
    ).toEqual(['/w/notes.md', '/w/new.md', '/w/old.md']);
  });
});

describe('normalizeEditPath', () => {
  it('normalizes separators, dot segments and Windows drives', () => {
    expect(normalizeEditPath('/a//b/./c/../d.md')).toEqual({
      path: '/a/b/d.md',
      absolute: true,
      caseInsensitive: false,
    });
    expect(normalizeEditPath('c:\\Users\\R\\Notes.md')).toEqual({
      path: 'C:/Users/R/Notes.md',
      absolute: true,
      caseInsensitive: true,
    });
    expect(normalizeEditPath('docs/./a.md')?.path).toBe('docs/a.md');
    expect(normalizeEditPath('../outside.md')).toBeNull();
    expect(normalizeEditPath('   ')).toBeNull();
  });

  it('matches relative paths at segment boundaries', () => {
    const target = normalizeEditPath(
      '/Users/r/Cowork/research/onboarding findings.md',
    );
    expect(target).not.toBeNull();
    if (!target) return;
    expect(
      editPathMatchesRelativePath(target, 'research/onboarding findings.md'),
    ).toBe(true);
    expect(editPathMatchesRelativePath(target, 'onboarding findings.md')).toBe(
      true,
    );
    expect(editPathMatchesRelativePath(target, 'findings.md')).toBe(false);
    expect(editPathMatchesRelativePath(target, '')).toBe(false);
  });

  it('compares Windows paths case-insensitively and POSIX paths exactly', () => {
    const windows = normalizeEditPath('C:\\Work\\Docs\\Résumé.md');
    const posix = normalizeEditPath('/work/Docs/Résumé.md');
    if (!windows || !posix) throw new Error('expected paths');
    expect(editPathMatchesRelativePath(windows, 'docs/résumé.md')).toBe(true);
    expect(editPathMatchesRelativePath(posix, 'docs/Résumé.md')).toBe(false);
    expect(editPathMatchesRelativePath(posix, 'Docs/Résumé.md')).toBe(true);
  });
});

describe('createAgentFileEditTracker', () => {
  it('waits for explicit result metadata without poisoning a later completion', () => {
    const tracker = createAgentFileEditTracker();
    const use = toolUse('partial-result', 'Edit', EDIT_INPUT);
    expect(
      tracker.ingest(event([use, toolResult('partial-result', undefined)])),
    ).toEqual([]);
    expect(
      tracker.ingest(event([toolResult('partial-result', false)])),
    ).toHaveLength(1);
  });

  it('remembers an explicit error that arrives before its use', () => {
    const tracker = createAgentFileEditTracker();
    tracker.ingest(event([toolResult('failed-first', true)]));
    expect(
      tracker.ingest(
        event([
          toolUse('failed-first', 'Edit', EDIT_INPUT),
          toolResult('failed-first', false),
        ]),
      ),
    ).toEqual([]);
  });

  it('consumes the real persisted message projection with an embedded completion', () => {
    const message = persistedMessageToPortalMessage({
      scope: 'worktree',
      workspaceLocalId: 'p1',
      worktreeLocalId: 'wt1',
      chatId: 'chat-1',
      message: {
        id: 'projected-message',
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'real-projector',
            toolName: 'Edit',
            input: EDIT_INPUT,
          },
          {
            type: 'tool_result',
            toolUseId: 'real-projector',
            toolName: 'Edit',
            output: 'Updated',
            isError: false,
          },
        ],
      },
    });
    expect(
      message.parts?.filter((part) => part.kind === 'tool_result'),
    ).toHaveLength(0);
    expect(
      createAgentFileEditTracker().ingest(event([], {}, message))[0]?.paths,
    ).toEqual(['/Users/r/Cowork/onboarding-findings.md']);
  });

  it('does not lose later patch paths when completion precedes the full input', () => {
    const tracker = createAgentFileEditTracker();
    const partial = '*** Begin Patch\n*** Update File: a.md\n*** Add File: b';
    expect(
      tracker.ingest(
        event([
          toolUse('patch', 'apply_patch', partial),
          toolResult('patch', false),
        ]),
      )[0]?.paths,
    ).toEqual(['a.md']);
    expect(
      tracker.ingest(event([toolUse('patch', 'apply_patch', partial)])),
    ).toEqual([]);
    expect(
      tracker.ingest(
        event([
          toolUse('patch', 'apply_patch', partial + '.md\n+x\n*** End Patch'),
        ]),
      )[0]?.paths,
    ).toEqual(['b.md']);
  });

  it('consumes the persisted projector embedded result and object input', () => {
    const tracker = createAgentFileEditTracker();
    expect(
      tracker.ingest(
        event([
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'object',
              toolName: 'Write',
              input: { file_path: '/w/notes.md', content: 'eight' },
              result: { output: 'ok', isError: false },
            },
          },
        ]),
      ),
    ).toEqual([
      {
        scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
        paths: ['/w/notes.md'],
      },
    ]);
  });

  it('lets an embedded error override an earlier separate success', () => {
    const tracker = createAgentFileEditTracker();
    tracker.ingest(event([toolResult('t1', false)]));
    expect(
      tracker.ingest(
        event([
          {
            kind: 'tool_use',
            data: {
              toolUseId: 't1',
              toolName: 'Edit',
              input: EDIT_INPUT,
              result: { output: 'denied', isError: true },
            },
          },
        ]),
      ),
    ).toEqual([]);
  });

  it('retries extraction until all completed input paths are available', () => {
    const tracker = createAgentFileEditTracker();
    expect(
      tracker.ingest(
        event([toolUse('t1', 'Edit', ''), toolResult('t1', false)]),
      ),
    ).toEqual([]);
    expect(
      tracker.ingest(event([toolUse('t1', 'Edit', EDIT_INPUT)])),
    ).toHaveLength(1);
  });

  it('does not confuse same-length input updates with unchanged input', () => {
    const tracker = createAgentFileEditTracker();
    tracker.ingest(event([toolUse('t1', 'Edit', '{"wrong_key":"/a.md"}')]));
    expect(
      tracker.ingest(
        event([
          toolUse('t1', 'Edit', '{"file_path":"/a.md"}'),
          toolResult('t1', false),
        ]),
      ),
    ).toHaveLength(1);
  });

  it('rejects ambiguous duplicate top-level paths even in truncated JSON', () => {
    expect(
      extractAgentEditPaths(
        'Write',
        '{"file_path":"/a.md","file_path":"/b.md","content":"cut',
      ),
    ).toEqual([]);
    expect(
      extractAgentEditPaths(
        'Write',
        '{"file_path":"/a.md","file_path":"/b.md"}',
      ),
    ).toEqual([]);
  });

  it('reports an embedded successful result once', () => {
    const tracker = createAgentFileEditTracker();
    const parts = [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)];

    expect(tracker.ingest(event(parts))).toEqual([
      {
        scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
        paths: ['/Users/r/Cowork/onboarding-findings.md'],
      },
    ]);
    expect(tracker.ingest(event(parts))).toEqual([]);
  });

  it('pairs a use and a result that arrive in separate messages and roles', () => {
    const tracker = createAgentFileEditTracker();
    expect(tracker.ingest(event([toolUse('t1', 'Edit', EDIT_INPUT)]))).toEqual(
      [],
    );
    const edits = tracker.ingest(
      event([toolResult('t1', false)], {}, { messageId: 'm2', role: 'user' }),
    );
    expect(edits).toHaveLength(1);
  });

  it('pairs a result that arrives before its use', () => {
    const tracker = createAgentFileEditTracker();
    expect(tracker.ingest(event([toolResult('t1', false)]))).toEqual([]);
    expect(
      tracker.ingest(event([toolUse('t1', 'Write', EDIT_INPUT)])),
    ).toHaveLength(1);
  });

  it('requires an explicit success and lets an error win', () => {
    const tracker = createAgentFileEditTracker();
    const use = toolUse('t1', 'Edit', EDIT_INPUT);
    expect(tracker.ingest(event([use]))).toEqual([]);
    expect(tracker.ingest(event([use, toolResult('t2', undefined)]))).toEqual(
      [],
    );
    expect(
      tracker.ingest(
        event([toolUse('t3', 'Edit', EDIT_INPUT), toolResult('t3', true)]),
      ),
    ).toEqual([]);
    expect(
      tracker.ingest(
        event(
          [toolUse('t4', 'Edit', EDIT_INPUT), toolResult('t4', false)],
          {},
          { status: 'failed' },
        ),
      ),
    ).toEqual([]);
  });

  it('keys calls by scope and chat, not tool-use id alone', () => {
    const tracker = createAgentFileEditTracker();
    const parts = [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)];
    expect(tracker.ingest(event(parts))).toHaveLength(1);
    expect(tracker.ingest(event(parts, { chatId: 'chat-2' }))).toHaveLength(1);
    expect(
      tracker.ingest(event(parts, { worktreeLocalId: 'wt2' })),
    ).toHaveLength(1);
  });

  it('skips events without a project and worktree scope', () => {
    const tracker = createAgentFileEditTracker();
    const parts = [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)];
    expect(
      tracker.ingest(
        event(parts, { workspaceLocalId: undefined, scope: 'standalone' }),
      ),
    ).toEqual([]);
  });

  it('merges canonical and local scope ids', () => {
    const tracker = createAgentFileEditTracker();
    const parts = [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)];
    const [edit] = tracker.ingest(
      event(parts, { projectId: 'canonical-p', worktreeId: 'canonical-wt' }),
    );
    expect(edit?.scope).toEqual({
      projectIds: ['canonical-p', 'p1'],
      worktreeIds: ['canonical-wt', 'wt1'],
    });
  });

  it('treats completions older than activation as history', () => {
    const tracker = createAgentFileEditTracker({ notBeforeMs: 5_000 });
    const parts = [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)];
    expect(tracker.ingest(event(parts, {}, { createdAtMs: 1_000 }))).toEqual(
      [],
    );
    // A later replay of the same call stays handled.
    expect(tracker.ingest(event(parts, {}, { createdAtMs: 9_000 }))).toEqual(
      [],
    );
    expect(
      tracker.ingest(
        event(
          [toolUse('t2', 'Edit', EDIT_INPUT), toolResult('t2', false)],
          {},
          { createdAtMs: 1_000, updatedAtMs: 6_000 },
        ),
      ),
    ).toHaveLength(1);
  });

  it('finds edits inside nested agent blocks', () => {
    const tracker = createAgentFileEditTracker();
    const agent: PortalChatPart = {
      kind: 'agent',
      data: {
        toolUseId: 'agent-1',
        subBlocks: [toolUse('t1', 'Edit', EDIT_INPUT), toolResult('t1', false)],
      },
    };
    expect(tracker.ingest(event([agent]))).toHaveLength(1);
  });

  it('bounds remembered calls', () => {
    const tracker = createAgentFileEditTracker({ maxTrackedCalls: 2 });
    for (const id of ['a', 'b', 'c']) {
      tracker.ingest(event([toolUse(id, 'Edit', EDIT_INPUT)]));
    }
    // `a` was evicted, so its result alone cannot be paired.
    expect(tracker.ingest(event([toolResult('a', false)]))).toEqual([]);
    expect(tracker.ingest(event([toolResult('c', false)]))).toHaveLength(1);
  });

  it('reports nothing for a successful call without resolvable paths', () => {
    const tracker = createAgentFileEditTracker();
    expect(
      tracker.ingest(
        event([toolUse('t1', 'Edit', 'garbage'), toolResult('t1', false)]),
      ),
    ).toEqual([]);
  });
});
