import type { PendingSystemInstruction } from '../types';

const RESERVED_SYSTEM_INSTRUCTION_CLOSE = '</system_instruction>';
const WORKTREE_RELOCATION_INSTRUCTION_ID = 'worktree-relocation';

/**
 * Replace any unconsumed relocation note with the latest worktree move.
 *
 * Provider-native forks and archive restores retain their source conversation
 * (including compacted summaries and old environment context), so changing the
 * runtime cwd alone does not reliably teach the model that the chat moved. This
 * one-shot instruction makes the new location authoritative on the first
 * destination turn while preserving unrelated pending instructions.
 */
export function withWorktreeRelocationInstruction(
  instructions: PendingSystemInstruction[] | undefined,
  sourceCwd: string,
  destinationCwd: string,
  branchContext?: { sourceBranch?: string },
): PendingSystemInstruction[] {
  const retained = (instructions ?? []).filter(
    (instruction) =>
      instruction.id !== WORKTREE_RELOCATION_INSTRUCTION_ID &&
      (!branchContext || instruction.id !== 'independent-agent-start'),
  );
  if (sourceCwd === destinationCwd) return retained;

  return [
    ...retained,
    {
      id: WORKTREE_RELOCATION_INSTRUCTION_ID,
      text: sanitizeSystemInstructionText(
        [
          ...(branchContext
            ? [
                'This conversation is now a forked chat in a fresh branch and working directory.',
                `New working directory: ${JSON.stringify(destinationCwd)}.`,
                `Originating worktree location: ${JSON.stringify(sourceCwd)}.`,
                `Originating branch: ${branchContext.sourceBranch ? JSON.stringify(branchContext.sourceBranch) : 'unavailable'}.`,
                'Use the originating worktree and branch only for read-only reference. Limit all changes to the new working directory; do not edit files, commit, switch branches, or perform other mutating operations in the originating worktree.',
              ]
            : []),
          `This conversation moved from the working directory at ${JSON.stringify(sourceCwd)} into ${JSON.stringify(destinationCwd)}.`,
          `The current working directory and project root are now ${JSON.stringify(destinationCwd)}.`,
          `Treat absolute paths under ${JSON.stringify(sourceCwd)} in earlier messages or compacted context as historical references and rewrite them to the equivalent path under ${JSON.stringify(destinationCwd)} before acting.`,
          'Do not report or use the source directory as the current working directory.',
        ].join(' '),
      ),
    },
  ];
}

/**
 * Make arbitrary text safe to carry as a pending system instruction.
 *
 * {@link formatPendingSystemInstructionBlock} DROPS an instruction containing
 * the reserved closing delimiter rather than escaping it, which is the right
 * call for a wrapper that must not be breakable from inside. But a caller
 * building an instruction out of model output or user text needs a way to keep
 * its instruction instead of silently losing it: without this, a summary that
 * merely quotes the delimiter is discarded whole, and the send path then clears
 * the pending list, so the instruction is gone with nothing to show for it.
 *
 * Neutralizes the delimiter (case-insensitively, matching the filter) while
 * leaving the surrounding text readable.
 */
export function sanitizeSystemInstructionText(text: string): string {
  return text.replace(
    /<\/system_instruction>/gi,
    '[reserved-delimiter-removed]',
  );
}

export function formatPendingSystemInstructionBlock(
  instructions: PendingSystemInstruction[] | undefined,
): string {
  const texts = (instructions ?? [])
    .map((instruction) => instruction.text.trim())
    .filter(
      (text) =>
        text.length > 0 &&
        !text.toLowerCase().includes(RESERVED_SYSTEM_INSTRUCTION_CLOSE),
    );

  return texts.length > 0
    ? ['<system_instruction>', ...texts, '</system_instruction>'].join('\n')
    : '';
}
