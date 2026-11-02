import type {
  ApprovalRequestDetails,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  desktopTurnApprovalWait,
  matchWaitingToolUseIds,
} from '../tool-approval-matching';
import type { DisplayBlock, DisplayMessage } from '../types';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import { expandTurnFileRecords } from '@canopy/protocol/turn-files';

function approval(
  details: ApprovalRequestDetails,
  extra: Partial<ApprovalRequestEvent> = {},
): ApprovalRequestEvent {
  return {
    requestId: `request-${Math.random()}`,
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    provider: 'claude',
    title: 'Allow?',
    details,
    ...extra,
  };
}

function call(
  toolUseId: string,
  toolName: string,
  input: unknown,
  result?: { output: string; isError: boolean },
): DisplayBlock {
  return {
    type: 'tool_use',
    toolUseId,
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    ...(result ? { result } : {}),
  };
}

function turn(...blocks: DisplayBlock[]): DisplayMessage[] {
  return [{ id: 'assistant', role: 'assistant', blocks, timestamp: 0 }];
}

function claudeAgent(...subBlocks: DisplayBlock[]): DisplayBlock {
  return {
    type: 'agent',
    toolUseId: 'agent-1',
    subagentType: 'general-purpose',
    description: 'Helper',
    prompt: 'Help',
    runInBackground: false,
    subBlocks,
  };
}

const command = (value: string): ApprovalRequestDetails => ({
  kind: 'command',
  command: value,
});

it('keeps a waiting edit attached to its receipt-resolved file identity', () => {
  const messages = turn(
    call(
      'receipt',
      'ShowFiles',
      {},
      {
        output: JSON.stringify({
          files: [
            { path: 'src/a.ts', absolutePath: '/repo/src/a.ts', ok: true },
          ],
        }),
        isError: false,
      },
    ),
    call('edit', 'Edit', { file_path: 'src/a.ts' }),
  );
  const wait = desktopTurnApprovalWait(
    [approval({ kind: 'file-write', path: 'src/a.ts' }, { toolUseId: 'edit' })],
    messages,
  );
  const pending = expandTurnFileRecords(collectTurnFiles(messages)).find(
    (file) => file.state === 'creating',
  );
  expect(pending?.path).toBe('/repo/src/a.ts');
  expect(wait.isCallWaiting({ toolUseId: 'edit', toolName: 'Edit' })).toBe(
    true,
  );
  expect(wait.isFileWaiting(pending?.path ?? '')).toBe(true);
  expect(wait.isFileWaiting('/other/src/a.ts')).toBe(false);
});

describe('matchWaitingToolUseIds (CAN-5291)', () => {
  it('matches an explicit id exactly and never falls back from it', () => {
    const messages = turn(call('a', 'Bash', { command: 'pnpm test' }));
    expect([
      ...matchWaitingToolUseIds(
        [approval(command('pnpm test'), { toolUseId: 'a' })],
        messages,
      ),
    ]).toEqual(['a']);
    expect(
      matchWaitingToolUseIds(
        [approval(command('pnpm test'), { toolUseId: 'other' })],
        messages,
      ).size,
    ).toBe(0);
  });

  it('matches an id-less command against its own call only', () => {
    const messages = turn(
      call('running', 'Bash', { command: 'sleep 30' }),
      call('asking', 'Bash', { command: 'rm -rf dist' }),
    );
    expect([
      ...matchWaitingToolUseIds([approval(command('rm -rf dist'))], messages),
    ]).toEqual(['asking']);
  });

  it('leaves an approved running call alone until its request streams in', () => {
    const messages = turn(call('running', 'Bash', { command: 'sleep 30' }));
    expect(
      matchWaitingToolUseIds([approval(command('rm -rf dist'))], messages).size,
    ).toBe(0);
  });

  it('leaves duplicate commands and same-name tools ambiguous', () => {
    const duplicate = turn(
      call('a', 'Bash', { command: 'pnpm test' }),
      call('b', 'Bash', { command: 'pnpm test' }),
    );
    expect(
      matchWaitingToolUseIds([approval(command('pnpm test'))], duplicate).size,
    ).toBe(0);
    const tools = turn(call('a', 'WebFetch', {}), call('b', 'WebFetch', {}));
    expect(
      matchWaitingToolUseIds(
        [approval({ kind: 'tool', toolName: 'WebFetch' })],
        tools,
      ).size,
    ).toBe(0);
  });

  it('does not equate distinct commands', () => {
    const messages = turn(call('a', 'Bash', { command: 'git  push' }));
    expect(
      matchWaitingToolUseIds([approval(command('git push'))], messages).size,
    ).toBe(0);
  });

  it('ignores settled calls and malformed input safely', () => {
    const messages = turn(
      call(
        'done',
        'Bash',
        { command: 'pnpm test' },
        {
          output: 'ok',
          isError: false,
        },
      ),
      call('broken', 'Bash', '{not json'),
    );
    expect(
      matchWaitingToolUseIds([approval(command('pnpm test'))], messages).size,
    ).toBe(0);
  });

  it('matches files by whole trailing segments, never by basename', () => {
    const messages = turn(
      call('a', 'Write', { file_path: '/repo/src/index.ts', content: '' }),
      call('b', 'Edit', { file_path: '/repo/test/index.ts' }),
    );
    const write = (details: {
      path?: string;
      displayPath?: string;
    }): ReadonlySet<string> =>
      matchWaitingToolUseIds(
        [approval({ kind: 'file-write', ...details })],
        messages,
      );
    expect([...write({ path: '/repo/src/index.ts' })]).toEqual(['a']);
    expect([...write({ displayPath: 'test/index.ts' })]).toEqual(['b']);
    expect(write({ displayPath: 'index.ts' }).size).toBe(0);
    expect(write({ displayPath: 'rc/index.ts' }).size).toBe(0);
    expect([...write({ path: 'C:\\repo\\src\\index.ts' })]).toEqual([]);
  });

  it('compares Windows paths without case and separators', () => {
    const messages = turn(
      call('a', 'Write', { file_path: 'C:\\Repo\\Notes.md', content: '' }),
    );
    expect([
      ...matchWaitingToolUseIds(
        [approval({ kind: 'file-write', path: 'c:/repo/notes.md' })],
        messages,
      ),
    ]).toEqual(['a']);
    expect([
      ...matchWaitingToolUseIds(
        [approval({ kind: 'file-write', displayPath: 'REPO\\Notes.md' })],
        messages,
      ),
    ]).toEqual(['a']);
    expect(
      matchWaitingToolUseIds(
        [approval({ kind: 'file-write', path: '/repo/Notes.md' })],
        turn(
          call('posix', 'Write', { file_path: '/repo/notes.md', content: '' }),
        ),
      ).size,
    ).toBe(0);
  });

  it('never matches a unique basename or a conflicting absolute path', () => {
    const messages = turn(
      call('a', 'Write', { file_path: '/repo/src/index.ts', content: '' }),
    );
    for (const details of [
      { kind: 'file-write', displayPath: 'index.ts' },
      {
        kind: 'file-write',
        path: '/other/src/index.ts',
        displayPath: 'src/index.ts',
      },
    ] as const) {
      expect(matchWaitingToolUseIds([approval(details)], messages).size).toBe(
        0,
      );
    }
  });

  it('does not match an explicit ID across agent scopes', () => {
    const messages = turn(call('root', 'Bash', { command: 'pnpm test' }));
    expect(
      matchWaitingToolUseIds(
        [
          approval(command('pnpm test'), {
            toolUseId: 'root',
            subagentId: 'nested',
          }),
        ],
        messages,
      ).size,
    ).toBe(0);
  });

  it('does not leak a root wait into a nested call reusing the same ID', () => {
    const messages = turn(
      call('reused', 'Bash', { command: 'pnpm test' }),
      claudeAgent(call('reused', 'Bash', { command: 'pnpm test' })),
    );
    for (const request of [
      approval(command('pnpm test')),
      approval(command('pnpm test'), { toolUseId: 'reused' }),
    ]) {
      expect(matchWaitingToolUseIds([request], messages).size).toBe(0);
    }
  });

  it('matches MCP and tool details', () => {
    const messages = turn(
      call('mcp', 'mcp__linear__create_issue', {}),
      call('fetch', 'WebFetch', {}),
    );
    expect(
      [
        ...matchWaitingToolUseIds(
          [
            approval({ kind: 'mcp', server: 'linear', tool: 'create_issue' }),
            approval({ kind: 'tool', toolName: 'WebFetch' }),
          ],
          messages,
        ),
      ].sort(),
    ).toEqual(['fetch', 'mcp']);
  });

  it('falls back to the only call of its kind when nothing compares', () => {
    const messages = turn(call('a', 'Write', { content: '' }));
    expect([
      ...matchWaitingToolUseIds([approval({ kind: 'file-write' })], messages),
    ]).toEqual(['a']);
  });

  it('keeps subagent and root scopes apart', () => {
    const messages = turn(
      call('root', 'Bash', { command: 'pnpm test' }),
      claudeAgent(call('nested', 'Bash', { command: 'pnpm test' })),
    );
    expect([
      ...matchWaitingToolUseIds(
        [approval(command('pnpm test'), { subagentId: 'agent-x' })],
        messages,
      ),
    ]).toEqual([]);
    expect([
      ...matchWaitingToolUseIds([approval(command('pnpm test'))], messages),
    ]).toEqual(['root']);
  });

  it('keeps a call covered by any remaining request', () => {
    const messages = turn(
      call('a', 'Bash', { command: 'pnpm test' }),
      call('b', 'Bash', { command: 'pnpm lint' }),
    );
    const both = [
      approval(command('pnpm test')),
      approval(command('pnpm lint')),
    ];
    expect(matchWaitingToolUseIds(both, messages).size).toBe(2);
    expect([...matchWaitingToolUseIds(both.slice(1), messages)]).toEqual(['b']);
    const overlapping = [
      approval(command('pnpm test')),
      approval(command('pnpm test')),
    ];
    expect([...matchWaitingToolUseIds(overlapping.slice(1), messages)]).toEqual(
      ['a'],
    );
  });

  it('matches a call that streams in after its request', () => {
    const request = [approval(command('pnpm test'))];
    expect(matchWaitingToolUseIds(request, turn()).size).toBe(0);
    expect([
      ...matchWaitingToolUseIds(
        request,
        turn(call('late', 'Bash', { command: 'pnpm test' })),
      ),
    ]).toEqual(['late']);
  });
});

describe('desktopTurnApprovalWait (CAN-5291)', () => {
  it('marks the matched call and the files it writes', () => {
    const wait = desktopTurnApprovalWait(
      [approval({ kind: 'file-write', path: '/repo/notes.md' })],
      turn(
        call('write', 'Write', { file_path: '/repo/notes.md', content: '' }),
        call('edit', 'Edit', { file_path: '/repo/other.md' }),
      ),
    );
    expect(wait.isCallWaiting({ toolName: 'Write', toolUseId: 'write' })).toBe(
      true,
    );
    expect(wait.isCallWaiting({ toolName: 'Edit', toolUseId: 'edit' })).toBe(
      false,
    );
    expect(wait.isCallWaiting({ toolName: 'Write' })).toBe(false);
    expect(wait.isFileWaiting('/repo/notes.md')).toBe(true);
    expect(wait.isFileWaiting('/repo/other.md')).toBe(false);
  });

  it('waits on nothing once every request resolves', () => {
    const wait = desktopTurnApprovalWait(
      [],
      turn(call('a', 'Bash', { command: 'pnpm test' })),
    );
    expect(wait.isCallWaiting({ toolName: 'Bash', toolUseId: 'a' })).toBe(
      false,
    );
  });
});

it('uses known Codex thread scope and preserves mixed pending contributors (CAN-5291)', () => {
  const nested: DisplayBlock = {
    type: 'codex_agent',
    agentBlockId: 'agent',
    callId: 'spawn',
    status: 'running',
    senderThreadId: 'root',
    receiverThreadIds: ['child'],
    prompt: '',
    description: '',
    displayName: 'Helper',
    agentsStates: {},
    subBlocks: [call('nested', 'Edit', { file_path: '/repo/a.ts' })],
  };
  const messages = turn(
    call('running', 'Edit', { file_path: '/repo/a.ts' }),
    nested,
  );
  const requests = [
    approval(
      { kind: 'file-write', path: '/repo/a.ts' },
      { subagentId: 'child' },
    ),
  ];
  const wait = desktopTurnApprovalWait(requests, messages);
  expect(wait.isCallWaiting({ toolName: 'Edit', toolUseId: 'nested' })).toBe(
    true,
  );
  expect(wait.isCallWaiting({ toolName: 'Edit', toolUseId: 'running' })).toBe(
    false,
  );
  expect(wait.isFileWaiting('/repo/a.ts')).toBe(true);
  expect(
    matchWaitingToolUseIds(
      [
        approval(
          { kind: 'file-write', path: '/repo/a.ts' },
          { subagentId: 'other' },
        ),
      ],
      messages,
    ).size,
  ).toBe(0);
  expect(
    desktopTurnApprovalWait([], messages).isFileWaiting('/repo/a.ts'),
  ).toBe(false);
});
