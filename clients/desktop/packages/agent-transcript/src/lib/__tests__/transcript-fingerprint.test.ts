import type { PersistedChatBlock } from '../../types';
import {
  blockFingerprint,
  normalizeFingerprintText,
  LAYOUT_BLOCK_TYPES,
} from '../transcript-fingerprint';

/**
 * These fingerprint strings are the ones the renderer's `transcript-dedupe`
 * copy produced before CAN-3083 collapsed the duplicated implementations into
 * this module. Asserting them byte-for-byte is what makes the collapse
 * provably non-breaking: every variant but `claude_terminal_sync_warning`
 * (which main was silently missing an arm for) must be unchanged.
 */
const EXPECTED: Array<[string, PersistedChatBlock, string]> = [
  ['text', { type: 'text', text: '  hello   world \n' }, 'text:hello world'],
  ['thinking', { type: 'thinking', text: 'pondering' }, 'thinking:pondering'],
  [
    'file_references',
    {
      type: 'file_references',
      references: [
        { displayPath: 'src/a.ts', absolutePath: '/repo/src/a.ts' },
        { displayPath: '', absolutePath: '/repo/src/b.ts' },
      ],
    },
    'file_references:src/a.ts\n/repo/src/b.ts',
  ],
  [
    'tool_use',
    {
      type: 'tool_use',
      toolUseId: 'ignored',
      toolName: 'Bash',
      input: '{"a":1}',
    },
    'tool_use:Bash:{"a":1}',
  ],
  [
    'tool_result',
    {
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      output: 'out',
      isError: false,
    },
    'tool_result:tu-1:Bash:out:false',
  ],
  [
    'compaction_info',
    {
      type: 'compaction_info',
      timestamp: 5,
      provider: 'claude',
      interfaceMode: 'canopy',
      sessionId: 's-1',
      sourceEventId: 'e-1',
      summary: ' a  b ',
    },
    'compaction_info:e-1:s-1:a b',
  ],
  [
    'claude_terminal_sync_warning',
    {
      type: 'claude_terminal_sync_warning',
      timestamp: 7,
      message: ' late  sync ',
    },
    'claude_terminal_sync_warning:7:late sync',
  ],
  [
    'turn_timer',
    {
      type: 'turn_timer',
      startedAt: 1,
      pausedAt: 2,
      resumedAt: 3,
      accumulatedPausedDurationMs: 4,
      completedAt: null,
    },
    'turn_timer:1:2:3:4:null',
  ],
  [
    'hook_info',
    { type: 'hook_info', triggerName: 'pre-commit', timestamp: 9 },
    'hook_info:pre-commit:9',
  ],
  [
    'automation_info',
    { type: 'automation_info', timestamp: 9 },
    'automation_info::9',
  ],
  [
    'rebase_resolution_info',
    {
      type: 'rebase_resolution_info',
      kind: 'rebase_conflict',
      repoName: 'canopy',
      branchName: 'feature',
      timestamp: 3,
    },
    'rebase_resolution_info:rebase_conflict:canopy:feature',
  ],
  [
    'builtin_gh_chat_info',
    { type: 'builtin_gh_chat_info', kind: 'ci_check_fix', timestamp: 3 },
    'builtin_gh_chat_info:ci_check_fix::',
  ],
  [
    'pending_setup_info',
    { type: 'pending_setup_info', timestamp: 11 },
    'pending_setup_info:11',
  ],
  [
    'revert_info',
    {
      type: 'revert_info',
      timestamp: 12,
      revertedFromMessageId: 'msg-1',
      revertedFromTimestamp: 13,
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
    },
    'revert_info:msg-1:13',
  ],
];

describe('blockFingerprint', () => {
  it.each(EXPECTED)(
    'is byte-identical to the pre-refactor string for %s',
    (_label, block, expected) => {
      expect(blockFingerprint(block)).toBe(expected);
    },
  );

  it('uses receipt identity rather than identical command text or timestamps', () => {
    const block = {
      type: 'approval_safety_denied_info',
      receiptId: 'r1',
      timestamp: 1,
      reason: 'force-push',
      mode: 'ask',
      command: 'git push -f origin main',
    } as const;
    expect(blockFingerprint(block)).toBe(
      blockFingerprint({ ...block, timestamp: 2 }),
    );
    expect(blockFingerprint(block)).not.toBe(
      blockFingerprint({ ...block, receiptId: 'r2' }),
    );
  });

  it('fingerprints approval_resolution_info by its resolution identity', () => {
    expect(
      blockFingerprint({
        type: 'approval_resolution_info',
        timestamp: 42,
        resolvedBy: 'mode-change',
        mode: 'full-access',
        previousMode: 'ask',
        titles: ['ls apps/web/src/app/', 'cat README.md'],
      }),
    ).toBe(
      'approval_resolution_info:mode-change:full-access:ask:42:ls apps/web/src/app/\u0000cat README.md',
    );
  });

  it('distinguishes two resolutions that differ only in previousMode', () => {
    // `previousMode` decides whether the receipt credits a mode switch, so two
    // receipts that read differently must not share a fingerprint.
    const base: Extract<
      PersistedChatBlock,
      { type: 'approval_resolution_info' }
    > = {
      type: 'approval_resolution_info',
      timestamp: 42,
      resolvedBy: 'mode-change',
      mode: 'auto',
      titles: ['ls apps/web/src/app/'],
    };
    expect(blockFingerprint({ ...base, previousMode: 'ask' })).not.toBe(
      blockFingerprint(base),
    );
  });

  it('distinguishes two resolutions that released the same command', () => {
    // The dedupe hazard that ruled out a plain system-text message: two
    // byte-identical notices would silently collapse into one.
    const first = blockFingerprint({
      type: 'approval_resolution_info',
      timestamp: 1,
      resolvedBy: 'mode-change',
      mode: 'full-access',
      titles: ['ls apps/web/src/app/'],
    });
    const second = blockFingerprint({
      type: 'approval_resolution_info',
      timestamp: 2,
      resolvedBy: 'mode-change',
      mode: 'full-access',
      titles: ['ls apps/web/src/app/'],
    });
    expect(first).not.toBe(second);
  });

  it('falls back to a JSON shape for an unknown variant', () => {
    // A block variant added without an arm here must still dedupe by shape
    // rather than throw, so it is forced past the union deliberately.
    const unknownBlock: Record<string, unknown> = {
      type: 'future_block',
      value: 1,
    };
    expect(blockFingerprint(unknownBlock as never)).toBe(
      '{"type":"future_block","value":1}',
    );
  });

  it('survives an unserializable unknown variant', () => {
    const cyclic: Record<string, unknown> = { type: 'future_block' };
    cyclic.self = cyclic;
    expect(blockFingerprint(cyclic as never)).toBe(
      'unserializable_block:future_block',
    );
  });
});

describe('normalizeFingerprintText', () => {
  it('trims and collapses runs of whitespace', () => {
    expect(normalizeFingerprintText('\n a \t\t b  \n')).toBe('a b');
  });
});

describe('LAYOUT_BLOCK_TYPES', () => {
  it('matches the renderer list, plus the new approval resolution block', () => {
    expect(Array.from(LAYOUT_BLOCK_TYPES).sort()).toEqual(
      [
        // The account proxy's switch line (CAN-4021).
        'account_proxy_switch',
        'approval_resolution_info',
        'approval_safety_denied_info',
        'automation_info',
        'builtin_gh_chat_info',
        'claude_terminal_sync_warning',
        'hook_info',
        'mcp_activation',
        'pending_setup_info',
        'rebase_resolution_info',
        'revert_info',
        'turn_timer',
      ].sort(),
    );
  });

  it('does not treat conversation content as layout', () => {
    for (const type of ['text', 'thinking', 'tool_use', 'tool_result']) {
      expect(LAYOUT_BLOCK_TYPES.has(type)).toBe(false);
    }
  });

  it('misses renderer-only display variants that are not layout', () => {
    for (const type of ['agent', 'workflow', 'codex_agent']) {
      expect(LAYOUT_BLOCK_TYPES.has(type)).toBe(false);
    }
  });
});

it('fingerprints unsupported MCP records without interpreting recovery state', () => {
  const block: PersistedChatBlock = { type: 'mcp_activation', record: null };
  expect(() => blockFingerprint(block)).not.toThrow();
  expect(blockFingerprint(block)).toBe(
    blockFingerprint(structuredClone(block)),
  );
});
