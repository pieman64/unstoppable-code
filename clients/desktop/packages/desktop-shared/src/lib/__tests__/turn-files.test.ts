import type { TurnBlock, TurnMessage } from '../turn-utils';
import {
  expandTurnFileRecords,
  isTurnFileRecord,
  reconcileTurnFileRecords,
} from '@canopy/protocol/turn-files';
import {
  collectTurnFiles as collectTurnFileSnapshot,
  locateTurnFile,
  turnFilesOutsideDiff,
  turnFileWritePaths,
  type TurnFileLocation,
} from '../turn-files';

function collectTurnFiles(
  ...args: Parameters<typeof collectTurnFileSnapshot>
): ReturnType<typeof collectTurnFileSnapshot> {
  return collectTurnFileSnapshot(...args)
    .filter((file) => !file.removed)
    .map(({ evidence, ...file }) => {
      void evidence;
      return file;
    });
}

function tool(
  toolName: string,
  input: string,
  output = 'Done',
  isError = false,
): TurnMessage {
  return {
    id: toolName,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: toolName,
        toolName,
        input,
        result: { output, isError },
      },
    ],
  };
}

describe('turn file outputs', () => {
  it('preserves the explicit App Advisor workspace across later writes and history projections', () => {
    const target = { projectId: 'project', worktreeId: 'worktree' };
    const files = collectTurnFiles([
      tool(
        'app_advisor_show_files',
        JSON.stringify({ workspace: target }),
        JSON.stringify({
          files: [
            { path: 'report.md', absolutePath: '/project/report.md', ok: true },
          ],
        }),
      ),
      tool('Write', JSON.stringify({ file_path: '/project/report.md' })),
    ]);
    expect(files).toEqual([
      { path: '/project/report.md', state: 'ready', saved: true, target },
    ]);
    expect(collectTurnFiles([], files)).toEqual(files);
  });

  it('keeps historical App Advisor file presentations', () => {
    expect(
      collectTurnFiles([
        tool(
          'app_advisor_show_files',
          '{}',
          JSON.stringify({ files: [{ path: '/historical.md', ok: true }] }),
        ),
      ]),
    ).toEqual([{ path: '/historical.md', state: 'ready' }]);
  });

  it('includes nested subagent creations and reconciles their presentation receipts', () => {
    const subBlocks = tool(
      'Write',
      JSON.stringify({ file_path: 'report.md' }),
    ).blocks;
    const nested: TurnBlock = {
      type: 'agent',
      toolUseId: 'child',
      subagentType: 'general',
      description: 'Create report',
      prompt: '',
      runInBackground: false,
      subBlocks,
    };
    const parent: TurnBlock = {
      type: 'codex_agent',
      agentBlockId: 'parent',
      callId: 'call',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: '',
      description: 'Create report',
      displayName: 'Writer',
      agentsStates: {},
      subBlocks: [nested],
    };
    const message: TurnMessage = {
      id: 'nested',
      role: 'assistant',
      timestamp: 1,
      blocks: [parent],
    };
    expect(collectTurnFiles([message])).toEqual([
      { path: 'report.md', state: 'ready', saved: true },
    ]);
    expect(
      collectTurnFiles([
        message,
        tool(
          'ShowFiles',
          '{}',
          JSON.stringify({
            files: [
              {
                path: 'report.md',
                absolutePath: '/project/report.md',
                ok: true,
              },
            ],
          }),
        ),
      ]),
    ).toEqual([{ path: '/project/report.md', state: 'ready', saved: true }]);
    expect(collectTurnFiles([{ ...message, role: 'user' }])).toEqual([]);
  });

  it('reconciles a relative write with its absolute presentation receipt', () => {
    expect(
      collectTurnFiles([
        tool('Write', JSON.stringify({ file_path: './report.md' })),
        tool(
          'ShowFiles',
          '{}',
          JSON.stringify({
            files: [
              {
                path: 'report.md',
                absolutePath: '/project/report.md',
                ok: true,
              },
            ],
          }),
        ),
        tool('Write', JSON.stringify({ file_path: 'report.md' })),
      ]),
    ).toEqual([{ path: '/project/report.md', state: 'ready', saved: true }]);
  });

  it('deduplicates native writes and normalizes Windows paths without treating mentions or reads as outputs', () => {
    expect(
      collectTurnFiles([
        tool('Write', JSON.stringify({ file_path: 'C:\\work\\report.md' })),
        tool('Write', JSON.stringify({ file_path: 'C:/work/report.md' })),
        tool('Read', JSON.stringify({ file_path: '/input.md' })),
        tool('Edit', JSON.stringify({ file_path: '/existing.md' })),
        {
          id: 'prose',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: '[Input](/input.md)' }],
        },
      ]),
    ).toEqual([
      { path: 'C:/work/report.md', state: 'ready', saved: true },
      { path: '/existing.md', state: 'ready', change: 'updated' },
    ]);
  });

  it('uses Codex additions and updates, excluding standalone deletions', () => {
    expect(
      collectTurnFiles([
        tool(
          'file_change',
          'add: /report.md\nupdate: /existing.ts\ndelete: /removed.txt',
        ),
        tool(
          'apply_patch',
          '*** Begin Patch\n*** Add File: /table.csv\n+a,b\n*** Update File: /existing.ts\n*** End Patch',
        ),
      ]),
    ).toEqual([
      { path: '/report.md', state: 'ready', saved: true },
      { path: '/existing.ts', state: 'ready', change: 'updated' },
      { path: '/table.csv', state: 'ready', saved: true },
    ]);
  });

  it('projects explicit file presentations using validated returned paths, including shell-created deliverables', () => {
    expect(
      collectTurnFiles([
        tool(
          'ShowFiles',
          JSON.stringify({
            files: [{ path: 'report.pdf' }, { path: '/denied.pdf' }],
          }),
          JSON.stringify({
            opened: 1,
            failed: 1,
            files: [
              {
                path: 'report.pdf',
                absolutePath: '/project/report.pdf',
                ok: true,
              },
              { path: '/denied.pdf', ok: false, error: 'Denied' },
            ],
          }),
        ),
        tool(
          'mcp__unrelated__ShowFiles',
          '{}',
          JSON.stringify({ files: [{ path: '/spoof.md', ok: true }] }),
        ),
      ]),
    ).toEqual([{ path: '/project/report.pdf', state: 'ready' }]);
  });

  it('keeps pending and failed creations explicit and ignores malformed or non-file inputs', () => {
    const pending = tool('Write', JSON.stringify({ file_path: '/pending.md' }));
    const block = pending.blocks[0];
    if (block.type === 'tool_use') delete block.result;
    expect(
      collectTurnFiles([
        pending,
        tool(
          'Write',
          JSON.stringify({ file_path: '/failed.md' }),
          'Permission denied',
          true,
        ),
        tool('Write', '{partial'),
        tool(
          'Write',
          JSON.stringify({ file_path: 'https://example.com/report.md' }),
        ),
        tool('Write', JSON.stringify({ file_path: '/bad\u0000path' })),
      ]),
    ).toEqual([
      { path: '/pending.md', state: 'creating' },
      { path: '/failed.md', state: 'failed' },
    ]);
  });
});

describe('updated turn files', () => {
  const edit = (
    name = 'Edit',
    path = 'report.md',
    failed = false,
  ): TurnMessage =>
    tool(name, JSON.stringify({ file_path: path }), 'Done', failed);
  const pending = (message: TurnMessage): TurnMessage => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.type !== 'tool_use') return block;
      const { result, ...call } = block;
      void result;
      return call;
    }),
  });
  const updated = { path: 'report.md', state: 'ready', change: 'updated' };

  it.each(['Edit', 'MultiEdit'])(
    'collects successful %s without prose links',
    (name) => {
      expect(collectTurnFiles([edit(name), edit(name)])).toEqual([updated]);
      expect(collectTurnFiles([pending(edit(name))])).toEqual([
        { ...updated, state: 'creating' },
      ]);
      expect(collectTurnFiles([edit(name, 'report.md', true)])).toEqual([
        { ...updated, state: 'failed' },
      ]);
    },
  );

  it('validates edit paths and uses the supported path fallback', () => {
    expect(
      collectTurnFiles([
        tool('Edit', JSON.stringify({ path: 'a file.md' })),
        tool('MultiEdit', '{partial'),
        tool('Edit', JSON.stringify({ file_path: 42 })),
        tool('Edit', '{}'),
        tool('NotebookEdit', JSON.stringify({ file_path: 'notebook.ipynb' })),
      ]),
    ).toEqual([{ path: 'a file.md', state: 'ready', change: 'updated' }]);
  });

  it.each(['apply_patch', 'functions.apply_patch'])(
    'scopes moves to their %s update block',
    (name) => {
      expect(
        collectTurnFiles([
          tool(
            name,
            [
              '*** Begin Patch',
              '*** Update File: old name.md',
              '*** Move to: new name.md',
              '@@',
              '-old',
              '+new',
              '*** Add File: added.md',
              '+*** Move to: fake.md',
              '*** Update File: untouched.md',
              '@@',
              ' *** Move to: body.md',
              '*** Delete File: deleted.md',
              '*** Move to: orphan.md',
              '*** End Patch',
            ].join('\n'),
          ),
        ]),
      ).toEqual([
        {
          path: 'new name.md',
          state: 'ready',
          change: 'updated',
        },
        { path: 'added.md', state: 'ready', saved: true },
        { path: 'untouched.md', state: 'ready', change: 'updated' },
      ]);
    },
  );

  it('keeps successful creation precedence independent of order and retry results', () => {
    const write = tool('Write', JSON.stringify({ file_path: 'report.md' }));
    const failedWrite = tool(
      'Write',
      JSON.stringify({ file_path: 'report.md' }),
      'Denied',
      true,
    );
    for (const messages of [
      [write, edit()],
      [edit(), write],
      [write, edit('Edit', 'report.md', true)],
    ]) {
      expect(collectTurnFiles(messages)).toEqual([
        { path: 'report.md', state: 'ready', saved: true },
      ]);
    }
    for (const retry of [
      failedWrite,
      edit('Edit', 'report.md', true),
      pending(edit()),
      pending(write),
    ]) {
      expect(collectTurnFiles([edit(), retry])).toEqual([updated]);
    }
    expect(collectTurnFiles([failedWrite, edit()])).toEqual([updated]);
  });

  it('reconciles ShowFiles without losing explicit updates or successful adds', () => {
    const receipt = tool(
      'ShowFiles',
      '{}',
      JSON.stringify({
        files: [{ path: 'report.md', absolutePath: '/ws/report.md', ok: true }],
      }),
    );
    for (const messages of [
      [edit(), receipt],
      [receipt, edit()],
    ]) {
      expect(collectTurnFiles(messages)).toEqual([
        { ...updated, path: '/ws/report.md' },
      ]);
    }
    expect(
      collectTurnFiles(
        [receipt],
        [{ path: 'report.md', state: 'ready', change: 'updated' }],
      ),
    ).toEqual([{ ...updated, path: '/ws/report.md' }]);
    expect(
      collectTurnFiles([
        tool('Write', JSON.stringify({ file_path: '/ws/report.md' })),
        edit(),
        receipt,
      ]),
    ).toEqual([{ path: '/ws/report.md', state: 'ready', saved: true }]);
  });

  it('preserves successful saved precedence when replaying a partial window after serialization', () => {
    const write = tool('Write', JSON.stringify({ file_path: 'report.md' }));
    const retained: unknown = JSON.parse(
      JSON.stringify(collectTurnFiles([write, edit()])),
    );
    if (!Array.isArray(retained) || !retained.every(isTurnFileRecord))
      throw new Error('Invalid serialized turn files');
    const replayed = collectTurnFiles([edit()], retained);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.change).toBeUndefined();
  });

  it('never treats retained presentation evidence as a successful mutation', () => {
    const receipt = tool(
      'ShowFiles',
      '{}',
      '{"files":[{"path":"report.md","ok":true}]}',
    );
    const retained: unknown = JSON.parse(
      JSON.stringify(collectTurnFiles([receipt])),
    );
    if (!Array.isArray(retained) || !retained.every(isTurnFileRecord))
      throw new Error('Invalid serialized presentation');
    for (const operation of [
      pending(edit()),
      edit('Edit', 'report.md', true),
    ]) {
      const messages = [receipt, operation];
      expect(collectTurnFiles(messages, retained)).toEqual(
        collectTurnFiles(messages),
      );
      expect(collectTurnFiles([operation], retained)).toEqual(
        collectTurnFiles([operation]),
      );
    }
    // An unmarked legacy record still displays normally without richer evidence.
    expect(collectTurnFiles([], retained)).toEqual(retained);
  });

  it('preserves Windows identity and distinct POSIX case', () => {
    expect(
      collectTurnFiles([
        edit('Edit', 'C:\\ws\\Report.md'),
        edit('Edit', 'c:/WS/report.md'),
      ]),
    ).toHaveLength(1);
    expect(
      collectTurnFiles([
        edit('Edit', '/ws/Report.md'),
        edit('Edit', '/ws/report.md'),
      ]),
    ).toHaveLength(2);
    const receipt = tool(
      'ShowFiles',
      '{}',
      JSON.stringify({
        files: [
          { path: 'report.md', absolutePath: 'C:/ws/report.md', ok: true },
        ],
      }),
    );
    expect(
      collectTurnFiles([
        edit('Edit', 'Report.md'),
        receipt,
        edit('Edit', 'REPORT.md'),
      ]),
    ).toEqual([{ path: 'C:/ws/report.md', state: 'ready', change: 'updated' }]);
  });

  it.each([
    ['file_change', 'update: a file.md'],
    [
      'apply_patch',
      '*** Begin Patch\n*** Update File: a file.md\n@@\n-old\n+new\n*** End Patch',
    ],
    [
      'functions.apply_patch',
      '*** Begin Patch\n*** Update File: a file.md\n@@\n-old\n+new\n*** End Patch',
    ],
  ])(
    'keeps %s update lifecycle independent from classification',
    (name, input) => {
      expect(collectTurnFiles([pending(tool(name, input))])).toEqual([
        { path: 'a file.md', state: 'creating', change: 'updated' },
      ]);
      expect(collectTurnFiles([tool(name, input, 'Denied', true)])).toEqual([
        { path: 'a file.md', state: 'failed', change: 'updated' },
      ]);
      expect(
        collectTurnFiles([
          tool(name, input),
          tool(name, input, 'Denied', true),
        ]),
      ).toEqual([{ path: 'a file.md', state: 'ready', change: 'updated' }]);
    },
  );

  it('does not let presentation receipts complete pending or failed mutations', () => {
    const receipt = tool(
      'ShowFiles',
      '{}',
      '{"files":[{"path":"report.md","absolutePath":"/ws/report.md","ok":true}]}',
    );
    for (const message of [pending(edit()), edit('Edit', 'report.md', true)]) {
      const state =
        message.blocks[0].type === 'tool_use' && message.blocks[0].result
          ? 'failed'
          : 'creating';
      for (const messages of [
        [message, receipt],
        [receipt, message],
      ]) {
        expect(collectTurnFiles(messages)).toEqual([
          { path: '/ws/report.md', state, change: 'updated' },
        ]);
      }
    }
  });

  it('preserves successful adds across an edit and a later move', () => {
    for (const added of [
      tool('file_change', 'add: report.md'),
      tool('functions.apply_patch', '*** Add File: report.md\n+new'),
    ]) {
      expect(collectTurnFiles([edit(), added])).toEqual([
        { path: 'report.md', state: 'ready', saved: true },
      ]);
      expect(
        collectTurnFiles([
          added,
          edit(),
          tool(
            'apply_patch',
            '*** Update File: report.md\n*** Move to: renamed.md\n@@\n-old\n+new',
          ),
        ]),
      ).toEqual([
        {
          path: 'renamed.md',
          state: 'ready',
          saved: true,
        },
      ]);
    }
  });

  it('removes stale identities after successful moves and deletes, but not failed ones', () => {
    const move = tool(
      'apply_patch',
      '*** Begin Patch\n*** Update File: report.md\n*** Move to: renamed.md\n@@\n-old\n+new\n*** End Patch',
    );
    expect(collectTurnFiles([edit(), move])).toEqual([
      {
        path: 'renamed.md',
        state: 'ready',
        change: 'updated',
      },
    ]);
    expect(
      collectTurnFiles([edit(), tool('file_change', 'delete: report.md')]),
    ).toEqual([]);
    expect(
      collectTurnFiles([
        edit(),
        tool(
          'apply_patch',
          '*** Begin Patch\n*** Delete File: report.md\n*** End Patch',
        ),
      ]),
    ).toEqual([]);
    expect(
      collectTurnFiles([
        edit(),
        tool('file_change', 'delete: report.md', 'Denied', true),
      ]),
    ).toEqual([updated]);
    expect(
      collectTurnFiles([
        edit(),
        tool('file_change', 'delete: report.md'),
        edit(),
      ]),
    ).toEqual([updated]);
  });
});

describe('turn file locations', () => {
  const roots = [
    { repoId: 'root', absolutePath: '/ws' },
    { repoId: 'api', absolutePath: '/ws/repos/api' },
  ];

  it('locates an absolute path under its deepest root', () => {
    expect(locateTurnFile('/ws/repos/api/src/a.ts', roots)).toEqual({
      path: '/ws/repos/api/src/a.ts',
      absolutePath: '/ws/repos/api/src/a.ts',
      repoId: 'api',
      relativePath: 'src/a.ts',
    });
  });

  it('resolves a relative path against the first root', () => {
    expect(locateTurnFile('notes/./a.md', roots)).toEqual({
      path: 'notes/./a.md',
      absolutePath: '/ws/notes/a.md',
      repoId: 'root',
      relativePath: 'notes/a.md',
    });
  });

  it('rejects paths outside every root, traversal, the root itself and bad input', () => {
    expect(locateTurnFile('/tmp/a.md', roots)).toBeUndefined();
    expect(locateTurnFile('/ws/../a.md', roots)).toBeUndefined();
    expect(locateTurnFile('../a.md', roots)).toBeUndefined();
    expect(locateTurnFile('/ws', roots)).toBeUndefined();
    expect(locateTurnFile('/wsx/a.md', roots)).toBeUndefined();
    expect(locateTurnFile('', roots)).toBeUndefined();
    expect(locateTurnFile('/ws/a.md', [])).toBeUndefined();
    expect(
      locateTurnFile('/ws/a.md', [{ repoId: 'blank', absolutePath: '' }]),
    ).toBeUndefined();
  });

  it('matches Windows roots case-insensitively with either separator', () => {
    expect(
      locateTurnFile('c:/WS/out/Report.md', [
        { repoId: 'r', absolutePath: 'C:\\ws' },
      ]),
    ).toEqual({
      path: 'c:/WS/out/Report.md',
      absolutePath: 'c:/WS/out/Report.md',
      repoId: 'r',
      relativePath: 'out/Report.md',
    });
  });
});

describe('turn files outside the turn diff', () => {
  const located = (repoId: string, relativePath: string): TurnFileLocation => ({
    path: `/ws/${relativePath}`,
    absolutePath: `/ws/${relativePath}`,
    repoId,
    relativePath,
  });

  it('drops files the turn diff already lists for the same repository', () => {
    expect(
      turnFilesOutsideDiff(
        [
          located('api', 'src/a.ts'),
          located('root', 'README.md'),
          located('root', 'notes/other.md'),
        ],
        {
          files: [{ path: 'src/a.ts', repoId: 'api' }, { path: 'README.md' }],
        },
        'root',
      ),
    ).toEqual([located('root', 'notes/other.md')]);
  });

  it('keeps a same-named file from another repository and everything without a diff', () => {
    const files = [located('api', 'src/a.ts')];
    expect(
      turnFilesOutsideDiff(files, {
        files: [{ path: 'src/a.ts', repoId: 'web' }],
      }),
    ).toEqual(files);
    expect(turnFilesOutsideDiff(files, undefined)).toEqual(files);
  });

  it('keeps attachment roots distinct from an unscoped primary diff', () => {
    const files = [
      located('project', 'report.md'),
      located('attachments', 'report.md'),
    ];
    expect(
      turnFilesOutsideDiff(
        files,
        { files: [{ path: 'report.md' }] },
        'project',
      ),
    ).toEqual([located('attachments', 'report.md')]);
  });

  it('deduplicates Windows paths regardless of relative-path casing', () => {
    const file = {
      ...located('project', 'Out/Report.md'),
      absolutePath: 'C:/ws/Out/Report.md',
    };
    expect(
      turnFilesOutsideDiff(
        [file],
        { files: [{ path: 'out/report.md' }] },
        'project',
      ),
    ).toEqual([]);
  });
});

it('keeps evidence identities independent of written file contents', () => {
  const files = collectTurnFileSnapshot([
    tool(
      'Write',
      JSON.stringify({
        file_path: 'report.md',
        content: 'CAN4954-large-private-content',
      }),
    ),
  ]);
  expect(files[0]?.evidence?.[0]?.key).not.toContain(
    'CAN4954-large-private-content',
  );
});

it('projects a relative file under the filesystem root without creating a UNC path', () => {
  expect(
    locateTurnFile('report.md', [{ repoId: 'root', absolutePath: '/' }]),
  ).toEqual({
    path: 'report.md',
    absolutePath: '/report.md',
    relativePath: 'report.md',
    repoId: 'root',
  });
});

it.each([false, true])(
  'keeps retained completed evidence over an older pending row (failed=%s)',
  (failed) => {
    const finished = tool(
      'Edit',
      '{"file_path":"report.md"}',
      'Finished',
      failed,
    );
    const retained = collectTurnFileSnapshot([finished]);
    const older = {
      ...finished,
      blocks: finished.blocks.map((block) =>
        block.type === 'tool_use' ? { ...block, result: undefined } : block,
      ),
    };
    const replayed = collectTurnFileSnapshot([older], retained);
    expect(replayed[0]?.evidence).toHaveLength(1);
    expect(replayed[0]?.evidence?.[0]?.state).toBe(failed ? 'failed' : 'ready');
  },
);

it('keeps distinct message contributions when a tool identity is reused', () => {
  const first = { ...tool('Write', '{"file_path":"a.md"}'), id: 'first' };
  const second = { ...tool('Write', '{"file_path":"b.md"}'), id: 'second' };
  expect(
    expandTurnFileRecords(collectTurnFileSnapshot([first, second])).map(
      (file) => file.path,
    ),
  ).toEqual(['a.md', 'b.md']);
});

describe('denied writes while approval is pending (CAN-5291)', () => {
  const edit = (
    id: string,
    result?: { output: string; isError: boolean },
  ): TurnMessage => ({
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: id,
        toolName: 'Edit',
        input: JSON.stringify({ file_path: '/repo/a.ts' }),
        ...(result ? { result } : {}),
      },
    ],
  });
  const denied = { output: 'The user denied this tool use.', isError: true };

  it('keeps an earlier successful change when a later edit is denied', () => {
    const before = edit('first', { output: 'ok', isError: false });
    expect(collectTurnFiles([before, edit('second')])).toEqual([
      { path: '/repo/a.ts', state: 'ready', change: 'updated' },
    ]);
    expect(collectTurnFiles([before, edit('second', denied)])).toEqual([
      { path: '/repo/a.ts', state: 'ready', change: 'updated' },
    ]);
  });

  it('drops a pending file whose only write is denied', () => {
    expect(collectTurnFiles([edit('only')])).toEqual([
      { path: '/repo/a.ts', state: 'creating', change: 'updated' },
    ]);
    expect(collectTurnFiles([edit('only', denied)])).toEqual([
      { path: '/repo/a.ts', state: 'failed', change: 'updated' },
    ]);
  });

  it('names the paths a pending write touches', () => {
    expect(turnFileWritePaths(edit('only').blocks[0])).toEqual(['/repo/a.ts']);
  });

  it.each([false, true])(
    'retains an independent pending edit after denial across serialization (denied first: %s)',
    (deniedFirst) => {
      const messages = [edit('pending'), edit('denied', denied)];
      if (deniedFirst) messages.reverse();
      const snapshot = collectTurnFileSnapshot(messages);
      const serialized: unknown = JSON.parse(JSON.stringify(snapshot));
      if (!Array.isArray(serialized) || !serialized.every(isTurnFileRecord))
        throw new Error(
          'Collector output must remain compatible with the record validator',
        );
      const entries = expandTurnFileRecords(serialized).map((file) => ({
        identity: file.path,
        file,
      }));
      expect(reconcileTurnFileRecords(entries).map(({ file }) => file)).toEqual(
        [{ path: '/repo/a.ts', state: 'creating', change: 'updated' }],
      );
      // Updating the same contribution to terminal must remove its pending
      // evidence, including when the host retains the earlier snapshot.
      const settled = collectTurnFileSnapshot(
        [edit('pending', denied), edit('denied', denied)],
        snapshot,
      );
      expect(
        expandTurnFileRecords(settled).some(
          (file) => file.state === 'creating',
        ),
      ).toBe(false);
    },
  );
});
