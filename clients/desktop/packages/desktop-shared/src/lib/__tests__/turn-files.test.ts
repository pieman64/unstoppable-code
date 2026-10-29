import type { TurnBlock, TurnMessage } from '../turn-utils';
import {
  collectTurnFiles,
  locateTurnFile,
  turnFilesOutsideDiff,
  type TurnFileLocation,
} from '../turn-files';

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
      { path: '/project/report.md', state: 'ready', target },
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
      { path: 'report.md', state: 'ready' },
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
    ).toEqual([{ path: '/project/report.md', state: 'ready' }]);
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
    ).toEqual([{ path: '/project/report.md', state: 'ready' }]);
  });

  it('deduplicates native writes and normalizes Windows paths without treating mentions, reads or edits as outputs', () => {
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
    ).toEqual([{ path: 'C:/work/report.md', state: 'ready' }]);
  });

  it('uses Codex addition records and patch additions, excluding updates and deletions', () => {
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
      { path: '/report.md', state: 'ready' },
      { path: '/table.csv', state: 'ready' },
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
          files: [
            { path: 'src/a.ts', repoId: 'api', status: 'added' },
            { path: 'README.md', status: 'modified' },
          ],
        },
        'root',
      ),
    ).toEqual([located('root', 'notes/other.md')]);
  });

  it('keeps a same-named file from another repository and everything without a diff', () => {
    const files = [located('api', 'src/a.ts')];
    expect(
      turnFilesOutsideDiff(files, {
        files: [{ path: 'src/a.ts', repoId: 'web', status: 'added' }],
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
