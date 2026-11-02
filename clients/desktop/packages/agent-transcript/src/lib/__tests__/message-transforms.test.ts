/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { mergeToolResults } from '../message-transforms';
import type { DisplayBlock } from '../../message-display';
import type {
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '../../types';

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

type Block = {
  type: string;
  asyncQuestionAnswer?: {
    requestId: string;
    startsTurn: boolean;
    answers: Array<{ question: string; selectedOptions: string[] }>;
  };
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: string;
  output?: string;
  isError?: boolean;
  fullOutputRef?: PersistedToolOutputReference;
  visualRef?: PersistedVisualReference;
  startedAt?: number;
  completedAt?: number | null;
  agentBlockId?: string;
  callId?: string;
  tool?: string;
  status?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string;
  agentsStates?: Record<string, { status: string; message?: string | null }>;
  receiverAgents?: Record<string, { nickname?: string; role?: string }>;
  description?: string;
  displayName?: string;
  subBlocks?: Block[];
};

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  timestamp: number;
  parentToolUseId?: string;
  parentBlockId?: string;
};

function msg(
  id: string,
  role: 'user' | 'assistant' | 'system',
  blocks: Block[],
  extra?: { parentToolUseId?: string; parentBlockId?: string },
): Msg {
  return { id, role, blocks, timestamp: Date.now(), ...extra };
}

function textBlock(text: string): Block {
  return { type: 'text', text };
}

function toolUseBlock(
  toolUseId: string,
  toolName: string,
  input = '{}',
): Block {
  return { type: 'tool_use', toolUseId, toolName, input };
}

function toolResultBlock(
  toolUseId: string,
  toolName: string,
  output = '',
  isError = false,
): Block {
  return { type: 'tool_result', toolUseId, toolName, output, isError };
}

function thinkingBlock(text: string): Block {
  return { type: 'thinking', text };
}

// Cast helpers — message-transforms expects ChatMessage / DisplayMessage but
// our lightweight test fixtures match their structural shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asChat = (msgs: Msg[]): any[] => msgs;

function expectDisplayBlockType<T extends DisplayBlock['type']>(
  block: DisplayBlock,
  type: T,
): asserts block is Extract<DisplayBlock, { type: T }> {
  expect(block.type).toBe(type);
  if (block.type !== type) {
    throw new Error(`Expected ${type} block`);
  }
}

// ---------------------------------------------------------------------------
// mergeToolResults
// ---------------------------------------------------------------------------

describe('mergeToolResults', () => {
  const visualRef: PersistedVisualReference = {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'b'.repeat(64)}`,
    byteLength: 100,
    sha256: 'b'.repeat(64),
    mediaType: 'text/html',
    title: 'Preview',
    maxHeight: 400,
  };

  it('merges tool_result into corresponding tool_use', () => {
    const fullOutputRef: PersistedToolOutputReference = {
      version: 1,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 100_000,
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const resultBlock = toolResultBlock('tu1', 'Bash', 'file.txt');
    resultBlock.fullOutputRef = fullOutputRef;
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('tu1', 'Bash', '"ls"')]),
      msg('2', 'system', [resultBlock]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    expect(result[0].blocks).toHaveLength(1);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.result).toEqual({
      output: 'file.txt',
      isError: false,
      messageId: '2',
      toolUseId: 'tu1',
      fullOutputRef,
      outputTruncated: true,
      authFailure: undefined,
      authFailures: undefined,
    });
  });

  it('projects a visual reference with the persisted block identity', () => {
    const resultBlock = toolResultBlock('tu-visual', 'ShowVisual', 'published');
    resultBlock.visualRef = visualRef;
    const result = mergeToolResults(
      asChat([
        msg('1', 'assistant', [toolUseBlock('tu-visual', 'ShowVisual')]),
        msg('2', 'system', [resultBlock]),
      ]),
    );

    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.result).toStrictEqual({
      output: 'published',
      messageId: '2',
      toolUseId: 'tu-visual',
      visualRef,
      isError: false,
      authFailure: undefined,
      authFailures: undefined,
    });
  });

  it('projects both artifact references on a tool result', () => {
    const fullOutputRef: PersistedToolOutputReference = {
      version: 1,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 100_000,
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const resultBlock = toolResultBlock('tu-both', 'ShowVisual', 'published');
    resultBlock.fullOutputRef = fullOutputRef;
    resultBlock.visualRef = visualRef;
    const result = mergeToolResults(
      asChat([
        msg('1', 'assistant', [toolUseBlock('tu-both', 'ShowVisual')]),
        msg('2', 'system', [resultBlock]),
      ]),
    );

    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.result).toStrictEqual({
      output: 'published',
      messageId: '2',
      toolUseId: 'tu-both',
      fullOutputRef,
      outputTruncated: true,
      visualRef,
      isError: false,
      authFailure: undefined,
      authFailures: undefined,
    });
  });

  it('preserves the tool result shape when neither artifact reference exists', () => {
    const result = mergeToolResults(
      asChat([
        msg('1', 'assistant', [toolUseBlock('tu-plain', 'Read')]),
        msg('2', 'system', [toolResultBlock('tu-plain', 'Read', 'content')]),
      ]),
    );

    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.result).toStrictEqual({
      output: 'content',
      isError: false,
      authFailure: undefined,
      authFailures: undefined,
    });
  });

  it('resolves a SendMessage recipient to the dispatched agent description', () => {
    const input = asChat([
      msg('1', 'assistant', [
        toolUseBlock(
          'tu-task',
          'Task',
          JSON.stringify({
            subagent_type: 'general-purpose',
            description: 'Fix Task 18',
            prompt: 'do the thing',
          }),
        ),
      ]),
      msg('2', 'system', [
        toolResultBlock('tu-task', 'Task', 'agentId: ac70abe6769a1e1ea'),
      ]),
      msg('3', 'assistant', [
        toolUseBlock(
          'tu-send',
          'SendMessage',
          JSON.stringify({
            to: 'ac70abe6769a1e1ea',
            summary: 'Re-review',
            message: 'body',
          }),
        ),
      ]),
    ]);

    const result = mergeToolResults(input);
    const sendBlock = result
      .flatMap((m) => m.blocks)
      .find(
        (b): b is Extract<DisplayBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use' && b.toolName === 'SendMessage',
      );
    expect(sendBlock).toBeDefined();
    expect(sendBlock?.resolvedRecipient).toBe('Fix Task 18');
  });

  it('leaves the SendMessage recipient unresolved for an unknown agent id', () => {
    const input = asChat([
      msg('1', 'assistant', [
        toolUseBlock(
          'tu-send',
          'SendMessage',
          JSON.stringify({ to: 'unknown-id', summary: 's', message: 'm' }),
        ),
      ]),
    ]);

    const result = mergeToolResults(input);
    const sendBlock = result
      .flatMap((m) => m.blocks)
      .find(
        (b): b is Extract<DisplayBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use' && b.toolName === 'SendMessage',
      );
    expect(sendBlock).toBeDefined();
    expect(sendBlock?.resolvedRecipient).toBeUndefined();
  });

  it('resolves a nested SendMessage recipient to the dispatched agent description', () => {
    const input = asChat([
      msg('1', 'assistant', [
        toolUseBlock(
          'tu-task',
          'Task',
          JSON.stringify({
            subagent_type: 'general-purpose',
            description: 'Fix Task 18',
            prompt: 'do the thing',
          }),
        ),
      ]),
      msg('2', 'system', [
        toolResultBlock('tu-task', 'Task', 'agentId: ac70abe6769a1e1ea'),
      ]),
      msg(
        '3',
        'assistant',
        [
          toolUseBlock(
            'tu-send',
            'SendMessage',
            JSON.stringify({
              to: 'ac70abe6769a1e1ea',
              summary: 'Re-review',
              message: 'body',
            }),
          ),
        ],
        { parentToolUseId: 'tu-task' },
      ),
    ]);

    const result = mergeToolResults(input);
    const agentBlock = result
      .flatMap((m) => m.blocks)
      .find(
        (b): b is Extract<DisplayBlock, { type: 'agent' }> =>
          b.type === 'agent',
      );
    expect(agentBlock).toBeDefined();
    const sendBlock = agentBlock?.subBlocks.find(
      (b): b is Extract<DisplayBlock, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.toolName === 'SendMessage',
    );
    expect(sendBlock).toBeDefined();
    expect(sendBlock?.resolvedRecipient).toBe('Fix Task 18');
  });

  it('renders Codex cat SKILL.md command blocks as skill use', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock(
          'tu1',
          'command',
          "/bin/zsh -lc 'cat /Users/me/.codex/skills/.system/openai-docs/SKILL.md'",
        ),
      ]),
      msg('2', 'system', [toolResultBlock('tu1', 'command', '# Skill')]),
    ]);

    const result = mergeToolResults(input);

    expect(result).toHaveLength(1);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Skill');
    expect(JSON.parse(block.input)).toEqual({
      skill: 'openai-docs',
      raw_command:
        "/bin/zsh -lc 'cat /Users/me/.codex/skills/.system/openai-docs/SKILL.md'",
    });
    expect(block.result).toEqual({
      output: '# Skill',
      isError: false,
    });
  });

  it('keeps non-skill Codex command blocks as commands', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock('tu1', 'command', "/bin/zsh -lc 'pwd'"),
      ]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('command');
    expect(block.input).toBe("/bin/zsh -lc 'pwd'");
  });

  it('renders non-skill Codex cat command blocks as file reads', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock('tu1', 'command', "/bin/zsh -lc 'cat package.json'"),
      ]),
      msg('2', 'system', [toolResultBlock('tu1', 'command', '{ }')]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'package.json',
      raw_command: "/bin/zsh -lc 'cat package.json'",
    });
    expect(block.result).toEqual({
      output: '{ }',
      isError: false,
    });
  });

  it('renders Windows-wrapped non-skill Codex cat command blocks as file reads and preserves the raw command', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'cat package.json'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
      msg('2', 'system', [toolResultBlock('tu1', 'command', '{ }')]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'package.json',
      raw_command: rawCommand,
    });
    expect(block.result).toEqual({
      output: '{ }',
      isError: false,
    });
  });

  it('renders Windows Get-Content -Path command blocks as file reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path apps/desktop-app/src/main/lib/worktree-data-cleanup.ts'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'apps/desktop-app/src/main/lib/worktree-data-cleanup.ts',
      raw_command: rawCommand,
    });
  });

  it('renders double-quoted Windows Get-Content -LiteralPath command blocks as file reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Get-Content -LiteralPath .\scripts\stage-host-binaries.mjs"`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: String.raw`.\scripts\stage-host-binaries.mjs`,
      raw_command: rawCommand,
    });
  });

  it('preserves backslashes in quoted Windows Get-Content paths', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -LiteralPath "C:\Users\Tommy\repo\file.txt"'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: String.raw`C:\Users\Tommy\repo\file.txt`,
      raw_command: rawCommand,
    });
  });

  it('renders Windows Get-Content -Raw command blocks as file reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw packages/desktop-shared/src/node/codex-runtime/capability-root.ts'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path:
        'packages/desktop-shared/src/node/codex-runtime/capability-root.ts',
      raw_command: rawCommand,
    });
  });

  it.each([
    {
      name: 'after path',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path packages/desktop-shared/src/node/codex-runtime/capability-root.ts -Raw'`,
      expectedPath:
        'packages/desktop-shared/src/node/codex-runtime/capability-root.ts',
    },
    {
      name: 'before literal path',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw -LiteralPath .\scripts\stage-host-binaries.mjs'`,
      expectedPath: String.raw`.\scripts\stage-host-binaries.mjs`,
    },
    {
      name: 'with Windows alias',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'gc -Raw -Path packages/ui-shared/src/components/chat/tool-display.tsx'`,
      expectedPath: 'packages/ui-shared/src/components/chat/tool-display.tsx',
    },
  ])(
    'treats -Raw as interchangeable for full Windows Get-Content reads: $name',
    ({ rawCommand, expectedPath }) => {
      const input = asChat([
        msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
      ]);

      const result = mergeToolResults(input);
      const block = result[0].blocks[0];
      expectDisplayBlockType(block, 'tool_use');
      expect(block.toolName).toBe('Read');
      expect(JSON.parse(block.input)).toEqual({
        file_path: expectedPath,
        raw_command: rawCommand,
      });
    },
  );

  it('renders Windows Get-Content positional paths with harmless options as file reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content "packages/ui-shared/src/components/chat/tool-display.tsx" -Encoding utf8 -ErrorAction Stop -ReadCount 0 -Force'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      raw_command: rawCommand,
    });
  });

  it('renders Windows Get-Content aliases with -Path as file reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'gc -LiteralPath "apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts" -Encoding utf8'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Read');
    expect(JSON.parse(block.input)).toEqual({
      file_path:
        'apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts',
      raw_command: rawCommand,
    });
  });

  it('does not render non-Windows type commands as file reads', () => {
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', 'type package.json')]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('command');
  });

  it('renders Codex sed range command blocks as line reads', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock(
          'tu1',
          'command',
          `/bin/zsh -lc "sed -n '12,34p' src/app.ts"`,
        ),
      ]),
      msg('2', 'system', [toolResultBlock('tu1', 'command', 'lines')]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'src/app.ts',
      start: '12',
      end: '34',
      raw_command: `/bin/zsh -lc "sed -n '12,34p' src/app.ts"`,
    });
    expect(block.result).toEqual({
      output: 'lines',
      isError: false,
    });
  });

  it('renders Windows Get-Content array slice command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$lines=Get-Content -Path apps/desktop-app/src/main/lib/worktree-service.ts; $lines[1860..2430]'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
      msg('2', 'system', [toolResultBlock('tu1', 'command', 'lines')]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'apps/desktop-app/src/main/lib/worktree-service.ts',
      start: '1861',
      end: '2431',
      raw_command: rawCommand,
    });
    expect(block.result).toEqual({
      output: 'lines',
      isError: false,
    });
  });

  it('renders spaced Windows Get-Content array slice command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$lines = Get-Content -Path packages/ui-shared/src/components/chat/tool-display.tsx; $lines [1560..1595]'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      start: '1561',
      end: '1596',
      raw_command: rawCommand,
    });
  });

  it('renders Windows Get-Content -TotalCount command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts -TotalCount 220'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path:
        'apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts',
      start: '1',
      end: '220',
      raw_command: rawCommand,
    });
  });

  it('does not render Windows Get-Content -Raw -First command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw -Path packages/ui-shared/src/components/chat/tool-display.tsx -First 12'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('command');
  });

  it('renders Windows Get-Content -Tail command blocks as last-line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts -Tail 40'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path:
        'apps/desktop-app/src/renderer/src/components/chat/tool-call-display.ts',
      last: '40',
      raw_command: rawCommand,
    });
  });

  it('does not render Windows Get-Content -Raw pipelines as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw -Path packages/ui-shared/src/components/chat/tool-display.tsx | Select-Object -First 12'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('command');
  });

  it('renders Windows Get-Content piped to Select-Object -First as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path packages/ui-shared/src/components/chat/tool-display.tsx | Select-Object -First 25'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      start: '1',
      end: '25',
      raw_command: rawCommand,
    });
  });

  it('renders Windows Get-Content piped to Select-Object -Skip -First as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Path packages/ui-shared/src/components/chat/tool-display.tsx | select -Skip 1559 -First 36'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      start: '1560',
      end: '1595',
      raw_command: rawCommand,
    });
  });

  it('renders Windows Get-Content piped to Select-Object -Last as last-line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'type -Path packages/ui-shared/src/components/chat/tool-display.tsx | Select-Object -Last 20'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      last: '20',
      raw_command: rawCommand,
    });
  });

  it.each([
    {
      name: 'first lines',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -LiteralPath packages/ui-shared/src/components/chat/tool-display.tsx -First 12'`,
      expected: {
        file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
        start: '1',
        end: '12',
      },
    },
    {
      name: 'last lines',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -LiteralPath packages/ui-shared/src/components/chat/tool-display.tsx -Tail 12'`,
      expected: {
        file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
        last: '12',
      },
    },
    {
      name: 'pipeline range',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -LiteralPath packages/ui-shared/src/components/chat/tool-display.tsx | Select-Object -Skip 9 -First 3'`,
      expected: {
        file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
        start: '10',
        end: '12',
      },
    },
    {
      name: 'assignment slice',
      rawCommand: String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$lines = Get-Content -LiteralPath packages/ui-shared/src/components/chat/tool-display.tsx; $lines[10..12]'`,
      expected: {
        file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
        start: '11',
        end: '13',
      },
    },
  ])(
    'treats -LiteralPath like -Path for Windows Get-Content $name',
    ({ rawCommand, expected }) => {
      const input = asChat([
        msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
      ]);

      const result = mergeToolResults(input);
      const block = result[0].blocks[0];
      expectDisplayBlockType(block, 'tool_use');
      expect(block.toolName).toBe('ReadLines');
      expect(JSON.parse(block.input)).toEqual({
        ...expected,
        raw_command: rawCommand,
      });
    },
  );

  it('renders parenthesized Windows Get-Content array slice command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '(Get-Content -LiteralPath "apps/desktop-app/src/main/lib/worktree-service.ts")[12..34]'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'apps/desktop-app/src/main/lib/worktree-service.ts',
      start: '13',
      end: '35',
      raw_command: rawCommand,
    });
  });

  it('renders parenthesized Windows Get-Content alias array slice command blocks as line reads', () => {
    const rawCommand = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '(gc packages/ui-shared/src/components/chat/tool-display.tsx) [0..220]'`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'packages/ui-shared/src/components/chat/tool-display.tsx',
      start: '1',
      end: '221',
      raw_command: rawCommand,
    });
  });

  it('renders Codex cat piped to sed range command blocks as line reads', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock(
          'tu1',
          'command',
          `/bin/zsh -lc "cat src/app.ts | sed -n '5,8p'"`,
        ),
      ]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('ReadLines');
    expect(JSON.parse(block.input)).toEqual({
      file_path: 'src/app.ts',
      start: '5',
      end: '8',
      raw_command: `/bin/zsh -lc "cat src/app.ts | sed -n '5,8p'"`,
    });
  });

  it('renders Codex sed range command blocks on SKILL.md as skill use', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock(
          'tu1',
          'command',
          `/bin/zsh -lc "sed -n '1,20p' /Users/me/.codex/skills/.system/openai-docs/SKILL.md"`,
        ),
      ]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Skill');
    expect(JSON.parse(block.input)).toEqual({
      skill: 'openai-docs',
      file_path: '/Users/me/.codex/skills/.system/openai-docs/SKILL.md',
      start: '1',
      end: '20',
      raw_command: `/bin/zsh -lc "sed -n '1,20p' /Users/me/.codex/skills/.system/openai-docs/SKILL.md"`,
    });
  });

  it('renders Windows SKILL.md paths as skill use', () => {
    const skillPath = [
      'C:',
      'Users',
      'Tommy',
      '.codex',
      'skills',
      '.system',
      'openai-docs',
      'SKILL.md',
    ].join('\\');
    const rawCommand = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "sed -n '1,20p' '${skillPath}'"`;
    const input = asChat([
      msg('1', 'system', [toolUseBlock('tu1', 'command', rawCommand)]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Skill');
    expect(JSON.parse(block.input)).toEqual({
      skill: 'openai-docs',
      file_path: skillPath,
      start: '1',
      end: '20',
      raw_command: rawCommand,
    });
  });

  it('renders Codex cat SKILL.md piped to sed range as skill use', () => {
    const input = asChat([
      msg('1', 'system', [
        toolUseBlock(
          'tu1',
          'command',
          `/bin/zsh -lc "cat /Users/me/.codex/skills/.system/imagegen/SKILL.md | sed -n '3,9p'"`,
        ),
      ]),
    ]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'tool_use');
    expect(block.toolName).toBe('Skill');
    expect(JSON.parse(block.input)).toEqual({
      skill: 'imagegen',
      file_path: '/Users/me/.codex/skills/.system/imagegen/SKILL.md',
      start: '3',
      end: '9',
      raw_command: `/bin/zsh -lc "cat /Users/me/.codex/skills/.system/imagegen/SKILL.md | sed -n '3,9p'"`,
    });
  });

  it('preserves text blocks as-is', () => {
    const input = asChat([msg('1', 'assistant', [textBlock('hello')])]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    expect(result[0].blocks[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('filters empty thinking blocks before building display messages', () => {
    const input = asChat([
      msg('1', 'assistant', [textBlock('hello'), thinkingBlock('   ')]),
      msg('2', 'assistant', [thinkingBlock('   ')]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    expect(result[0].blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('strips standalone tool_result messages', () => {
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('tu1', 'Read')]),
      msg('2', 'system', [toolResultBlock('tu1', 'Read', 'content')]),
    ]);
    const result = mergeToolResults(input);
    // tool_result message should not appear as a separate DisplayMessage
    expect(result).toHaveLength(1);
  });

  it('handles Agent tool_use blocks by creating agent display blocks', () => {
    const agentInput = JSON.stringify({
      description: 'test agent',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    });
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('tu1', 'Agent', agentInput)]),
      msg('2', 'system', [toolResultBlock('tu1', 'Agent', 'agent result')]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'agent');
    expect(block.subagentType).toBe('general-purpose');
    expect(block.description).toBe('test agent');
    expect(block.prompt).toBe('do something');
  });

  it('filters EnterPlanMode tool_use blocks', () => {
    const input = asChat([
      msg('1', 'assistant', [
        textBlock('thinking...'),
        toolUseBlock('tu1', 'EnterPlanMode'),
      ]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0].type).toBe('text');
  });

  it('groups subagent messages under their parent agent block', () => {
    const agentInput = JSON.stringify({
      description: 'sub',
      prompt: 'help',
    });
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('agent1', 'Agent', agentInput)]),
      msg('sub1', 'assistant', [toolUseBlock('sub-tu1', 'Read')], {
        parentToolUseId: 'agent1',
      }),
      msg('sub2', 'system', [toolResultBlock('sub-tu1', 'Read', 'data')], {
        parentToolUseId: 'agent1',
      }),
      msg('2', 'system', [toolResultBlock('agent1', 'Agent', 'done')]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    const agentBlock = result[0].blocks[0];
    expectDisplayBlockType(agentBlock, 'agent');
    expect(agentBlock.subBlocks).toHaveLength(1);
    const subBlock = agentBlock.subBlocks[0];
    expectDisplayBlockType(subBlock, 'tool_use');
    expect(subBlock.toolName).toBe('Read');
    expect(subBlock.result).toEqual({
      output: 'data',
      isError: false,
    });
  });

  it('projects visual references for tool results in subagent message groups', () => {
    const agentInput = JSON.stringify({
      description: 'sub',
      prompt: 'help',
    });
    const subResultBlock = toolResultBlock(
      'sub-tu-visual',
      'ShowVisual',
      'published',
    );
    subResultBlock.visualRef = visualRef;
    const input = asChat([
      msg('1', 'assistant', [
        toolUseBlock('agent-visual', 'Agent', agentInput),
      ]),
      msg('sub1', 'assistant', [toolUseBlock('sub-tu-visual', 'ShowVisual')], {
        parentToolUseId: 'agent-visual',
      }),
      msg('sub-result', 'system', [subResultBlock], {
        parentToolUseId: 'agent-visual',
      }),
      msg('2', 'system', [toolResultBlock('agent-visual', 'Agent', 'done')]),
    ]);
    const result = mergeToolResults(input);

    const agentBlock = result[0].blocks[0];
    expectDisplayBlockType(agentBlock, 'agent');
    const subBlock = agentBlock.subBlocks[0];
    expectDisplayBlockType(subBlock, 'tool_use');
    expect(subBlock.result).toStrictEqual({
      output: 'published',
      messageId: 'sub-result',
      toolUseId: 'sub-tu-visual',
      visualRef,
      isError: false,
      authFailure: undefined,
      authFailures: undefined,
    });
  });

  it('drops empty messages (all blocks filtered)', () => {
    const input = asChat([
      msg('1', 'system', [toolResultBlock('tu1', 'Bash', 'out')]),
    ]);
    const result = mergeToolResults(input);
    expect(result).toHaveLength(0);
  });

  it('keeps each Codex receiver thread result on its own command', () => {
    // One spawn with two receivers; Codex item ids repeat across threads.
    const card = {
      type: 'codex_agent_call',
      agentBlockId: 'pair',
      callId: 'pair',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'root',
      receiverThreadIds: ['lint', 'test'],
      prompt: '',
      agentsStates: {},
    };
    const child = (
      threadId: string,
      command: string,
      output: string,
    ): ReturnType<typeof msg> & {
      parentBlockId: string;
      codexThreadId: string;
    } => ({
      ...msg(`${threadId}-command`, 'assistant', [
        toolUseBlock('codex-item_1', 'Bash', command),
        {
          ...toolResultBlock('codex-item_1', 'Bash', output),
          isError: threadId === 'lint',
        },
      ]),
      parentBlockId: 'pair',
      codexThreadId: threadId,
    });
    const result = mergeToolResults(
      asChat([
        msg('card-message', 'assistant', [card]),
        child('lint', 'npm run lint', 'lint failed: 3 errors'),
        child('test', 'npm test', '12 passing'),
      ]),
    );
    const display = result[0].blocks[0];
    expectDisplayBlockType(display, 'codex_agent');
    const rows = display.subBlocks.flatMap((block) =>
      block.type === 'tool_use'
        ? [{ input: block.input, result: block.result }]
        : [],
    );
    expect(
      rows.map((row) => ({
        input: row.input,
        output: row.result?.output,
        isError: row.result?.isError,
      })),
    ).toEqual([
      { input: 'npm run lint', output: 'lint failed: 3 errors', isError: true },
      { input: 'npm test', output: '12 passing', isError: false },
    ]);
  });

  it('retains nested Codex agent content regardless of group encounter order', () => {
    const parent = {
      type: 'codex_agent_call',
      agentBlockId: 'parent',
      callId: 'parent',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'root',
      receiverThreadIds: ['child'],
      prompt: '',
      agentsStates: {},
    };
    const nested = {
      ...parent,
      agentBlockId: 'nested',
      callId: 'nested',
      senderThreadId: 'child',
      receiverThreadIds: ['grandchild'],
    };
    const childMessage = {
      ...msg('child-message', 'assistant', [nested]),
      parentBlockId: 'parent',
    };
    const grandchildMessage = {
      ...msg('grandchild-message', 'assistant', [
        textBlock('Nested report'),
        toolUseBlock('cmd', 'Bash', 'pwd'),
        toolResultBlock('cmd', 'Bash', '/repo'),
      ]),
      parentBlockId: 'nested',
    };
    for (const children of [
      [childMessage, grandchildMessage],
      [grandchildMessage, childMessage],
    ]) {
      const result = mergeToolResults(
        asChat([msg('parent-message', 'assistant', [parent]), ...children]),
      );
      const card = result[0].blocks[0];
      expectDisplayBlockType(card, 'codex_agent');
      const nestedCard = card.subBlocks[0];
      expectDisplayBlockType(nestedCard, 'codex_agent');
      expect(nestedCard.subBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Nested report' }),
          expect.objectContaining({
            type: 'tool_use',
            toolUseId: 'cmd',
          }),
        ]),
      );
      const tool = nestedCard.subBlocks.find(
        (block) => block.type === 'tool_use',
      );
      expect(tool?.result?.output).toBe('/repo');
    }
  });

  it('groups subagent messages by parentBlockId (Codex provider-neutral path)', () => {
    const codexAgentBlock: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-call-1',
      callId: 'call-1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['sub-1'],
      prompt: 'Look at handlers',
      agentsStates: { 'sub-1': { status: 'running', message: null } },
    };

    const input = asChat([
      msg('parent', 'assistant', [codexAgentBlock]),
      msg('sub-text', 'assistant', [textBlock('inside subagent')], {
        parentBlockId: 'codex-agent-call-1',
      }),
    ]);

    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'codex_agent');
    expect(block.subBlocks).toHaveLength(1);
    const subBlock = block.subBlocks[0];
    expectDisplayBlockType(subBlock, 'text');
    expect(subBlock.text).toBe('inside subagent');
  });

  it('preserves system provenance on nested Codex subagent blocks', () => {
    const codexAgentBlock: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-auth',
      callId: 'call-auth',
      tool: 'spawnAgent',
      status: 'failed',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['sub-auth'],
      prompt: 'Continue the task',
      agentsStates: {
        'sub-auth': { status: 'failed', message: 'Unauthorized' },
      },
    };

    const result = mergeToolResults(
      asChat([
        msg('parent-auth', 'assistant', [codexAgentBlock]),
        msg('nested-auth', 'system', [textBlock('Error: Unauthorized')], {
          parentBlockId: 'codex-agent-auth',
        }),
      ]),
    );

    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'codex_agent');
    expect(block.subBlocks).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'Error: Unauthorized',
        isSystemMessage: true,
      }),
    ]);
  });

  it('hides transient Codex spawn starts with no receiver thread', () => {
    const transientStart: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-transient',
      callId: 'transient',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root-thread',
      receiverThreadIds: [],
      prompt: 'Attempt that never materialized',
      agentsStates: {},
    };
    const completedSpawn: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-completed',
      callId: 'completed',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['sub-1'],
      prompt: 'Real subagent',
      agentsStates: {
        'sub-1': { status: 'completed', message: 'done' },
      },
    };

    const result = mergeToolResults(
      asChat([
        msg('transient', 'assistant', [transientStart]),
        msg('completed', 'assistant', [completedSpawn]),
      ]),
    );

    const codexAgentBlocks = result
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'codex_agent');
    expect(codexAgentBlocks).toHaveLength(1);
    expectDisplayBlockType(codexAgentBlocks[0], 'codex_agent');
    expect(codexAgentBlocks[0].agentBlockId).toBe('codex-agent-completed');
  });

  it('preserves Claude Agent grouping by parentToolUseId when parentBlockId is absent', () => {
    const agentInput = JSON.stringify({
      description: 'sub',
      prompt: 'help',
    });
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('agent1', 'Agent', agentInput)]),
      msg('sub1', 'assistant', [toolUseBlock('sub-tu1', 'Read')], {
        parentToolUseId: 'agent1',
      }),
      msg('2', 'system', [toolResultBlock('agent1', 'Agent', 'done')]),
    ]);
    const result = mergeToolResults(input);
    const agentBlock = result[0].blocks[0];
    expectDisplayBlockType(agentBlock, 'agent');
    expect(agentBlock.subBlocks).toHaveLength(1);
    const subBlock = agentBlock.subBlocks[0];
    expectDisplayBlockType(subBlock, 'tool_use');
    expect(subBlock.toolName).toBe('Read');
  });

  it('folds a nested Claude Agent call into a nested agent card with its own rows', () => {
    const outerInput = JSON.stringify({
      subagent_type: 'Explore',
      description: 'Map the API routes',
      prompt: 'List every route.',
    });
    const nestedInput = JSON.stringify({
      subagent_type: 'general-purpose',
      description: 'Check the auth middleware',
      prompt: 'Report which routes skip requireAuth.',
    });
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('outer', 'Agent', outerInput)]),
      msg('o1', 'assistant', [toolUseBlock('nested', 'Agent', nestedInput)], {
        parentToolUseId: 'outer',
      }),
      msg('n1', 'assistant', [toolUseBlock('grep', 'Grep')], {
        parentToolUseId: 'nested',
      }),
      msg('n2', 'user', [toolResultBlock('grep', 'Grep', 'src/routes.ts:3')], {
        parentToolUseId: 'nested',
      }),
      msg('n3', 'assistant', [textBlock('Only /health skips it.')], {
        parentToolUseId: 'nested',
      }),
      msg(
        'o2',
        'user',
        [toolResultBlock('nested', 'Agent', 'Only /health skips it.')],
        { parentToolUseId: 'outer' },
      ),
      msg('2', 'user', [toolResultBlock('outer', 'Agent', 'Mapped 2 routes')]),
    ]);

    const outer = mergeToolResults(input)[0].blocks[0];
    expectDisplayBlockType(outer, 'agent');
    expect(outer.subBlocks).toHaveLength(1);
    const nested = outer.subBlocks[0];
    expectDisplayBlockType(nested, 'agent');
    expect(nested).toMatchObject({
      toolUseId: 'nested',
      subagentType: 'general-purpose',
      description: 'Check the auth middleware',
      prompt: 'Report which routes skip requireAuth.',
      runInBackground: false,
      result: { output: 'Only /health skips it.', isError: false },
    });
    expect(nested.subBlocks.map((block) => block.type)).toEqual([
      'tool_use',
      'text',
    ]);
  });

  it("folds a nested background agent's TaskOutput read into its card", () => {
    const nestedInput = JSON.stringify({
      description: 'Watch the logs',
      prompt: 'Tail the logs.',
      run_in_background: true,
    });
    const input = asChat([
      msg('1', 'assistant', [toolUseBlock('outer', 'Agent', '{}')]),
      msg('o1', 'assistant', [toolUseBlock('nested', 'Agent', nestedInput)], {
        parentToolUseId: 'outer',
      }),
      msg(
        'o2',
        'user',
        [toolResultBlock('nested', 'Agent', 'Launched.\nagentId: abc123')],
        { parentToolUseId: 'outer' },
      ),
      msg(
        'o3',
        'assistant',
        [
          toolUseBlock(
            'read',
            'TaskOutput',
            JSON.stringify({ task_id: 'abc123' }),
          ),
        ],
        { parentToolUseId: 'outer' },
      ),
      msg('o4', 'user', [toolResultBlock('read', 'TaskOutput', 'All quiet')], {
        parentToolUseId: 'outer',
      }),
    ]);

    const outer = mergeToolResults(input)[0].blocks[0];
    expectDisplayBlockType(outer, 'agent');
    expect(outer.subBlocks).toHaveLength(1);
    const nested = outer.subBlocks[0];
    expectDisplayBlockType(nested, 'agent');
    expect(nested.runInBackground).toBe(true);
    expect(nested.taskOutputResult).toEqual({
      output: 'All quiet',
      isError: false,
    });
  });

  it.each(['abc123', 'task-watch'])(
    "folds a later root turn's TaskOutput read into a nested background agent's card (agentId %s)",
    (agentId) => {
      const nestedInput = JSON.stringify({
        description: 'Watch the logs',
        prompt: 'Tail the logs.',
        run_in_background: true,
      });
      const input = asChat([
        msg('u1', 'user', [textBlock('Audit the logs.')]),
        msg('1', 'assistant', [toolUseBlock('outer', 'Agent', '{}')]),
        msg('o1', 'assistant', [toolUseBlock('nested', 'Agent', nestedInput)], {
          parentToolUseId: 'outer',
        }),
        msg(
          'o2',
          'user',
          [
            toolResultBlock(
              'nested',
              'Agent',
              `Launched.\nagentId: ${agentId}`,
            ),
          ],
          { parentToolUseId: 'outer' },
        ),
        msg('2', 'user', [toolResultBlock('outer', 'Agent', 'Started it.')]),
        msg('u2', 'user', [textBlock('Is the watcher done?')]),
        msg('3', 'assistant', [
          toolUseBlock(
            'read',
            'TaskOutput',
            JSON.stringify({ task_id: agentId }),
          ),
        ]),
        msg('4', 'user', [toolResultBlock('read', 'TaskOutput', 'All quiet')]),
        msg('5', 'assistant', [textBlock('The watcher saw nothing.')]),
      ]);

      const result = mergeToolResults(input);
      const outer = result
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'agent');
      expect(outer).toBeDefined();
      if (outer === undefined) return;
      expectDisplayBlockType(outer, 'agent');
      const nested = outer.subBlocks[0];
      expectDisplayBlockType(nested, 'agent');
      expect(nested.taskOutputResult).toEqual({
        output: 'All quiet',
        isError: false,
      });
      const visit = (blocks: DisplayBlock[]): string[] =>
        blocks.flatMap((block) => [
          ...(block.type === 'tool_use' ? [block.toolName] : []),
          ...('subBlocks' in block ? visit(block.subBlocks) : []),
        ]);
      expect(visit(result.flatMap((message) => message.blocks))).not.toContain(
        'TaskOutput',
      );
    },
  );

  describe('TaskOutput reads of one background agent', () => {
    const NOT_READY =
      '<retrieval_status>not_ready</retrieval_status>\n\n<task_id>abc123</task_id>\n\n<status>running</status>';
    const watchInput = JSON.stringify({
      description: 'Watch the logs',
      prompt: 'Tail the logs.',
      run_in_background: true,
    });
    const read = (id: string): Block =>
      toolUseBlock(id, 'TaskOutput', JSON.stringify({ task_id: 'abc123' }));
    const toolNames = (blocks: DisplayBlock[]): string[] =>
      blocks.flatMap((block) => [
        ...(block.type === 'tool_use' ? [block.toolName] : []),
        ...('subBlocks' in block ? toolNames(block.subBlocks) : []),
      ]);
    const agentById = (
      blocks: DisplayBlock[],
      toolUseId: string,
    ): Extract<DisplayBlock, { type: 'agent' }> | undefined => {
      for (const block of blocks) {
        if (block.type === 'agent' && block.toolUseId === toolUseId)
          return block;
        if ('subBlocks' in block) {
          const found = agentById(block.subBlocks, toolUseId);
          if (found) return found;
        }
      }
      return undefined;
    };

    it("keeps a later parent-level completed read over a sibling's earlier not-ready read", () => {
      const input = asChat([
        msg('1', 'assistant', [toolUseBlock('outer', 'Agent', '{}')]),
        msg('o1', 'assistant', [toolUseBlock('watch', 'Agent', watchInput)], {
          parentToolUseId: 'outer',
        }),
        msg(
          'o2',
          'user',
          [toolResultBlock('watch', 'Agent', 'Launched.\nagentId: abc123')],
          { parentToolUseId: 'outer' },
        ),
        msg('o3', 'assistant', [toolUseBlock('check', 'Agent', '{}')], {
          parentToolUseId: 'outer',
        }),
        msg('c1', 'assistant', [read('early')], { parentToolUseId: 'check' }),
        msg('c2', 'user', [toolResultBlock('early', 'TaskOutput', NOT_READY)], {
          parentToolUseId: 'check',
        }),
        msg('o4', 'user', [toolResultBlock('check', 'Agent', 'Still going.')], {
          parentToolUseId: 'outer',
        }),
        msg('o5', 'assistant', [read('late')], { parentToolUseId: 'outer' }),
        msg(
          'o6',
          'user',
          [toolResultBlock('late', 'TaskOutput', 'Finished: all quiet')],
          { parentToolUseId: 'outer' },
        ),
        msg('2', 'user', [toolResultBlock('outer', 'Agent', 'Done.')]),
      ]);

      const blocks = mergeToolResults(input).flatMap(
        (message) => message.blocks,
      );
      expect(agentById(blocks, 'watch')?.taskOutputResult).toEqual({
        output: 'Finished: all quiet',
        isError: false,
      });
      expect(toolNames(blocks)).not.toContain('TaskOutput');
    });

    it("keeps a later root completed read over a nested agent's earlier not-ready read", () => {
      const input = asChat([
        msg('1', 'assistant', [toolUseBlock('watch', 'Agent', watchInput)]),
        msg('2', 'user', [
          toolResultBlock('watch', 'Agent', 'Launched.\nagentId: abc123'),
        ]),
        msg('3', 'assistant', [toolUseBlock('check', 'Agent', '{}')]),
        msg('c1', 'assistant', [read('early')], { parentToolUseId: 'check' }),
        msg('c2', 'user', [toolResultBlock('early', 'TaskOutput', NOT_READY)], {
          parentToolUseId: 'check',
        }),
        msg('4', 'user', [toolResultBlock('check', 'Agent', 'Still going.')]),
        msg('5', 'assistant', [read('late')]),
        msg('6', 'user', [
          toolResultBlock('late', 'TaskOutput', 'Finished: all quiet'),
        ]),
      ]);

      const blocks = mergeToolResults(input).flatMap(
        (message) => message.blocks,
      );
      expect(agentById(blocks, 'watch')?.taskOutputResult).toEqual({
        output: 'Finished: all quiet',
        isError: false,
      });
      expect(toolNames(blocks)).not.toContain('TaskOutput');
    });

    it("folds an earlier sibling's read of a later sibling's task into the later card", () => {
      const background = JSON.stringify({
        prompt: 'Go.',
        run_in_background: true,
      });
      const input = asChat([
        msg('1', 'assistant', [toolUseBlock('outer', 'Agent', '{}')]),
        msg('o1', 'assistant', [toolUseBlock('reader', 'Agent', background)], {
          parentToolUseId: 'outer',
        }),
        msg(
          'o2',
          'user',
          [toolResultBlock('reader', 'Agent', 'Launched.\nagentId: aaa111')],
          { parentToolUseId: 'outer' },
        ),
        msg('o3', 'assistant', [toolUseBlock('target', 'Agent', background)], {
          parentToolUseId: 'outer',
        }),
        msg(
          'o4',
          'user',
          [toolResultBlock('target', 'Agent', 'Launched.\nagentId: bbb222')],
          { parentToolUseId: 'outer' },
        ),
        msg(
          'r1',
          'assistant',
          [
            toolUseBlock(
              'read',
              'TaskOutput',
              JSON.stringify({ task_id: 'bbb222' }),
            ),
          ],
          { parentToolUseId: 'reader' },
        ),
        msg(
          'r2',
          'user',
          [toolResultBlock('read', 'TaskOutput', 'Target finished.')],
          { parentToolUseId: 'reader' },
        ),
      ]);

      const blocks = mergeToolResults(input).flatMap(
        (message) => message.blocks,
      );
      expect(agentById(blocks, 'target')?.taskOutputResult).toEqual({
        output: 'Target finished.',
        isError: false,
      });
      expect(agentById(blocks, 'reader')?.taskOutputResult).toBeUndefined();
      expect(toolNames(blocks)).not.toContain('TaskOutput');
    });

    it('never lets a not-ready read replace or stand in for a completed one', () => {
      const completedFirst: Msg[] = [
        msg('1', 'assistant', [toolUseBlock('watch', 'Agent', watchInput)]),
        msg('2', 'user', [
          toolResultBlock('watch', 'Agent', 'Launched.\nagentId: abc123'),
        ]),
        msg('3', 'assistant', [read('done')]),
        msg('4', 'user', [
          toolResultBlock('done', 'TaskOutput', 'Finished: all quiet'),
        ]),
        msg('5', 'assistant', [read('again')]),
        msg('6', 'user', [toolResultBlock('again', 'TaskOutput', NOT_READY)]),
      ];
      const settled = mergeToolResults(asChat(completedFirst)).flatMap(
        (message) => message.blocks,
      );
      expect(agentById(settled, 'watch')?.taskOutputResult?.output).toBe(
        'Finished: all quiet',
      );

      const pending = mergeToolResults(
        asChat([...completedFirst.slice(0, 2), ...completedFirst.slice(4)]),
      ).flatMap((message) => message.blocks);
      expect(agentById(pending, 'watch')?.taskOutputResult).toBeUndefined();
      expect(toolNames(pending)).not.toContain('TaskOutput');
    });
  });

  it('converts a codex_agent_call into a codex_agent display block with derived displayName/description', () => {
    const codexAgentBlock: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-only',
      callId: 'only',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['sub-A', 'sub-B'],
      prompt: 'Investigate failing tests\n\nDetails follow.',
      agentsStates: {
        'sub-A': { status: 'running', message: null },
        'sub-B': { status: 'running', message: null },
      },
      receiverAgents: { 'sub-A': { role: 'explorer', nickname: 'Scout' } },
    };
    const input = asChat([msg('parent', 'assistant', [codexAgentBlock])]);

    const result = mergeToolResults(input);
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'codex_agent');
    expect(block.displayName).toBe('Scout (explorer)');
    expect(block.description).toBe('Investigate failing tests');
    expect(block.subBlocks).toEqual([]);
  });

  it.each([
    ['/root/readme_review', 'Readme Review'],
    ['/root/research/desktop-install', 'Desktop Install'],
    ['/root/  mixed__task--name  ', 'Mixed Task Name'],
    ['/root/readmeReview', 'Readme Review'],
  ])(
    'formats task path %s separately from nickname and prompt',
    (agentPath, title) => {
      const receiver = {
        nickname: 'Sartre',
        agentPath,
        model: 'gpt-6-astra',
        reasoningEffort: 'high',
      };
      const input = asChat([
        msg('parent', 'assistant', [
          {
            type: 'codex_agent_call',
            agentBlockId: 'child',
            callId: 'spawn',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'root',
            receiverThreadIds: ['child'],
            prompt: '',
            agentsStates: {},
            receiverAgents: {
              child: receiver,
            },
          },
        ]),
      ]);
      const block = mergeToolResults(input)[0].blocks[0];
      expectDisplayBlockType(block, 'codex_agent');
      expect(block.displayName).toBe('Sartre');
      expect(block.description).toBe(title);
      expect(block.prompt).toBe('');
      expect(block.model).toBe('gpt-6-astra');
      expect(block.reasoningEffort).toBe('high');
    },
  );

  it('gracefully falls back when a Codex agent role or nickname is missing', () => {
    const roleOnly: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-role',
      callId: 'role',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['sub-role'],
      prompt: 'work',
      agentsStates: {},
      receiverAgents: { 'sub-role': { role: 'reviewer' } },
    };
    const nicknameOnly: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-nickname',
      callId: 'nickname',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['sub-nickname'],
      prompt: 'work',
      agentsStates: {},
      receiverAgents: { 'sub-nickname': { nickname: 'Scout' } },
    };

    const result = mergeToolResults(
      asChat([
        msg('role', 'assistant', [roleOnly]),
        msg('nickname', 'assistant', [nicknameOnly]),
      ]),
    );

    const codexAgentBlocks = result
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'codex_agent');
    expect(codexAgentBlocks).toHaveLength(2);
    expectDisplayBlockType(codexAgentBlocks[0], 'codex_agent');
    expectDisplayBlockType(codexAgentBlocks[1], 'codex_agent');
    expect(codexAgentBlocks[0].displayName).toBe('reviewer');
    expect(codexAgentBlocks[1].displayName).toBe('Scout');
  });

  it('falls back to "Codex (N)" when no nickname/role is available for multiple receivers', () => {
    const codexAgentBlock: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-multi',
      callId: 'multi',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['x', 'y'],
      prompt: 'work',
      agentsStates: {},
    };
    const result = mergeToolResults(
      asChat([msg('p', 'assistant', [codexAgentBlock])]),
    );
    const block = result[0].blocks[0];
    expectDisplayBlockType(block, 'codex_agent');
    expect(block.displayName).toBe('Codex (2)');
  });
});

describe('Cursor display metadata', () => {
  it('uses display fields without mutating provider-accurate transcript blocks', () => {
    const block = {
      type: 'tool_use' as const,
      toolUseId: 'cursor-tool',
      toolName: 'Read package.json',
      input: '{"path":"package.json"}',
      display: { toolName: 'Read', input: '{"file_path":"package.json"}' },
    };
    const messages = [
      {
        id: 'cursor',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [block],
      },
    ];
    expect(mergeToolResults(messages)[0].blocks[0]).toMatchObject({
      toolName: 'Read',
      input: '{"file_path":"package.json"}',
    });
    expect(block.toolName).toBe('Read package.json');
    expect(block.input).toBe('{"path":"package.json"}');
  });

  it('shows a Cursor Ledger call under the Claude name and unwrapped arguments', () => {
    // As the Cursor projection persists an app-tool call: the CLI title and
    // raw ACP input, plus the display projection the renderer uses.
    const args = { type: 'TASK', title: 'Fix the checkout retry loop' };
    const block = {
      type: 'tool_use' as const,
      toolUseId: 'cursor-ledger',
      toolName: 'canopy: AddFeedEntry',
      input: JSON.stringify({
        providerIdentifier: 'canopy',
        toolName: 'AddFeedEntry',
        args,
      }),
      display: {
        toolName: 'mcp__canopy__AddFeedEntry',
        input: JSON.stringify(args),
      },
    };
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'cursor-ledger',
      toolName: 'canopy: AddFeedEntry',
      output: '{"success":true}',
      isError: false,
    };
    const messages = [
      {
        id: 'cursor-ledger',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [block, result],
      },
    ];

    const [merged] = mergeToolResults(messages)[0].blocks;
    expect(merged).toMatchObject({
      type: 'tool_use',
      toolName: 'mcp__canopy__AddFeedEntry',
      input: JSON.stringify(args),
      result: { output: '{"success":true}', isError: false },
    });
    expect(block.toolName).toBe('canopy: AddFeedEntry');
  });
});
